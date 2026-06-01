"""Large Folder Upload API routes — streams aws s3 sync output via SSE."""

import csv
import io
import json
import os
import subprocess
import threading
import time
import uuid
from collections.abc import Generator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from flask import Blueprint, Response, jsonify, request

from app.config import get_settings
from app.services.sse_manager import get_sse_manager

large_folder_upload_bp = Blueprint("large_folder_upload", __name__)

# In-memory registry of active sync jobs
_jobs: dict[str, "SyncJob"] = {}
_jobs_lock = threading.Lock()


@dataclass
class SyncJob:
    job_id: str
    folder_path: str
    s3_prefix: str
    s3_uri: str
    cmd_base: list[str]  # base command without --dryrun
    status: str = "running"  # running | completed | failed | cancelled
    process: subprocess.Popen[str] | None = field(default=None, repr=False)
    return_code: int | None = None
    lines: list[str] = field(default_factory=list)
    total_files: int = 0  # populated after dry-run
    done_files: int = 0
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    upload_started_at: float = field(default_factory=time.monotonic)
    created_at: float = field(default_factory=time.time)


def _resolve_folder_path(folder: Path) -> Path:
    """Resolve a folder to an absolute, symlink-followed real path.

    A relative path is anchored to the configured ``default_upload_folder`` (the user's
    data root), never the process cwd — the launcher runs us with cwd=PROJECT_DIR, so
    resolving against it would point at the project, not the drive. The base is forced
    absolute (falling back to home) so the result is always absolute. ``resolve()`` also
    follows the symlinks that external and mounted drives are reached through, so
    ``aws s3 sync`` targets the real mount.
    """
    folder = folder.expanduser()
    if not folder.is_absolute():
        base = Path(get_settings().default_upload_folder).expanduser()
        if not base.is_absolute():
            base = Path.home()
        folder = base / folder
    return folder.resolve()


def _register(job: SyncJob) -> None:
    with _jobs_lock:
        _jobs[job.job_id] = job


def _get(job_id: str) -> SyncJob | None:
    with _jobs_lock:
        return _jobs.get(job_id)


def _save_sync_log(job: SyncJob, completed_at: datetime) -> None:
    """Write a summary JSONL log entry, a raw output text file, and an upload-history CSV."""
    try:
        from app.services.log_service import get_log_service
        from app.services.utils import format_file_size

        log = get_log_service()
        settings = get_settings()
        duration_s = (completed_at - job.started_at).total_seconds()
        log_dir = settings.log_directory

        # ── Raw text log ──────────────────────────────────────────────────────
        hive_txt = (
            log_dir
            / "sync"
            / f"year={completed_at.year:04d}"
            / f"month={completed_at.month:02d}"
            / f"day={completed_at.day:02d}"
        )
        hive_txt.mkdir(parents=True, exist_ok=True)
        time_str = completed_at.strftime("%H%M%S")
        short_id = job.job_id[:8]
        txt_path = hive_txt / f"sync-{time_str}-{short_id}.txt"
        with open(txt_path, "w", encoding="utf-8") as fh:
            fh.write(f"# Large Folder Upload — {job.job_id}\n")
            fh.write(f"# folder:  {job.folder_path}\n")
            fh.write(f"# dest:    {job.s3_uri}\n")
            fh.write(f"# started: {job.started_at.isoformat()}\n")
            fh.write(f"# ended:   {completed_at.isoformat()}\n")
            fh.write(f"# status:  {job.status}\n\n")
            fh.write("\n".join(job.lines))

        # ── Upload-history CSV (appears in Upload History tab) ────────────────
        _write_history_csv(job, completed_at, log_dir, time_str, short_id, format_file_size)

        # ── JSONL event log entry ─────────────────────────────────────────────
        if job.status == "completed":
            level = "INFO"
        elif job.status == "cancelled":
            level = "WARNING"
        else:
            level = "ERROR"
        log.log(
            level,
            "large_folder_sync",
            f"sync_{job.status}",
            f"Large folder sync {job.status}: {Path(job.folder_path).name} → {job.s3_uri}",
            {
                "job_id": job.job_id,
                "folder_path": job.folder_path,
                "s3_uri": job.s3_uri,
                "s3_prefix": job.s3_prefix,
                "return_code": job.return_code,
                "duration_seconds": round(duration_s, 1),
                "output_lines": len(job.lines),
                "log_file": str(txt_path.relative_to(log_dir)),
            },
        )
    except Exception:
        pass  # Never crash the streaming thread over logging


def _write_history_csv(
    job: SyncJob,
    completed_at: datetime,
    log_dir: Path,
    time_str: str,
    short_id: str,
    format_file_size: Any,
) -> None:
    """Write a CSV into logs/csv/ so this sync shows in the Upload History tab."""
    # Parse "upload: /local/path to s3://bucket/key" lines
    bucket = get_settings().s3_bucket
    upload_lines = [ln for ln in job.lines if ln.startswith("upload:")]
    if not upload_lines:
        # Nothing was uploaded (all skipped); still write an empty-session CSV
        upload_lines = []

    num_files = len(upload_lines)
    total_duration_s = (completed_at - job.started_at).total_seconds()
    per_file_duration = total_duration_s / num_files if num_files > 0 else 0.0

    columns = [
        "job_id",
        "filename",
        "file_size_bytes",
        "file_size_formatted",
        "s3_path",
        "status",
        "data_start_time",
        "upload_started_at",
        "upload_completed_at",
        "upload_duration_seconds",
        "upload_speed_mbps",
        "is_duplicate",
        "is_valid",
        "error_message",
    ]

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(columns)

    for line in upload_lines:
        # "upload: /local/path to s3://bucket/key"
        try:
            rest = line[len("upload:") :].strip()
            local_path, s3_full = rest.split(" to ", 1)
            local_path = local_path.strip()
            s3_full = s3_full.strip()
            filename = Path(local_path).name
            # Strip "s3://bucket/" to get the relative key
            s3_path = s3_full.replace(f"s3://{bucket}/", "", 1) if bucket else s3_full
        except ValueError:
            continue

        try:
            size_bytes = os.path.getsize(local_path)
        except OSError:
            size_bytes = 0

        speed = (
            round(size_bytes / per_file_duration / 1024 / 1024 * 8, 2)
            if per_file_duration > 0 and size_bytes > 0
            else ""
        )

        writer.writerow(
            [
                job.job_id,
                filename,
                size_bytes,
                format_file_size(size_bytes),
                s3_path,
                "completed",
                "",  # data_start_time — not available for sync
                job.started_at.isoformat(),
                completed_at.isoformat(),
                round(per_file_duration, 3),
                speed,
                False,  # is_duplicate — these were NOT skipped
                True,  # is_valid
                "",
            ]
        )

    hive_csv = (
        log_dir
        / "csv"
        / f"year={completed_at.year:04d}"
        / f"month={completed_at.month:02d}"
        / f"day={completed_at.day:02d}"
    )
    hive_csv.mkdir(parents=True, exist_ok=True)
    csv_path = hive_csv / f"upload-summary-{time_str}-{short_id}.csv"
    with open(csv_path, "w", encoding="utf-8", newline="") as fh:
        fh.write(buf.getvalue())


def _stream_process(job: SyncJob) -> None:
    """Dry-run to count files, then stream the real upload with progress events."""
    sse = get_sse_manager()

    # ── Phase 1: dry-run to count files that will actually be uploaded ──
    try:
        dryrun = subprocess.run(
            [*job.cmd_base, "--dryrun"],
            capture_output=True,
            text=True,
            timeout=300,
        )
        total = sum(1 for ln in dryrun.stdout.splitlines() if "(dryrun) upload:" in ln)
        job.total_files = total
        sse.send_event(job.job_id, {"type": "plan", "total_files": total})
    except Exception:
        # Dry-run failed — proceed without a known total
        sse.send_event(job.job_id, {"type": "plan", "total_files": 0})

    if job.status != "running":
        return  # Cancelled during dry-run

    # ── Phase 2: real upload ──
    try:
        proc = subprocess.Popen(
            job.cmd_base,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        job.process = proc
        job.upload_started_at = time.monotonic()

        for raw_line in proc.stdout:  # type: ignore[union-attr]
            stripped = raw_line.rstrip("\n")
            job.lines.append(stripped)

            if stripped.startswith("upload:"):
                job.done_files += 1
                elapsed = time.monotonic() - job.upload_started_at
                eta_s: int | None = None
                if job.total_files > 0 and job.done_files > 0:
                    remaining = job.total_files - job.done_files
                    eta_s = int(elapsed / job.done_files * remaining) if remaining > 0 else 0
                sse.send_event(
                    job.job_id,
                    {
                        "type": "file_done",
                        "line": stripped,
                        "done": job.done_files,
                        "total": job.total_files,
                        "elapsed_s": int(elapsed),
                        "eta_s": eta_s,
                    },
                )
            else:
                sse.send_event(job.job_id, {"type": "line", "line": stripped})

        proc.wait()
        job.return_code = proc.returncode

        if job.status == "running":
            job.status = "completed" if job.return_code == 0 else "failed"

        completed_at = datetime.now(UTC)
        _save_sync_log(job, completed_at)

        sse.send_event(
            job.job_id,
            {
                "type": "done",
                "status": job.status,
                "return_code": job.return_code,
                "done": job.done_files,
                "total": job.total_files,
            },
        )
    except Exception as exc:
        job.status = "failed"
        completed_at = datetime.now(UTC)
        _save_sync_log(job, completed_at)
        sse.send_event(
            job.job_id,
            {"type": "done", "status": "failed", "error": str(exc)},
        )


@large_folder_upload_bp.route("/start", methods=["POST"])
def start_sync() -> tuple[Response, int]:
    """Start an aws s3 sync job.

    Request body:
        folder_path: Local folder to sync from
        s3_prefix: S3 key prefix (e.g. "user_upload_2025-01-01T12-00-00")

    Returns:
        JSON with job_id
    """
    if not request.is_json:
        return jsonify({"error": "JSON body required"}), 400

    data: dict[str, Any] = request.get_json() or {}
    folder_path_raw: str = data.get("folder_path", "").strip()
    s3_prefix: str = data.get("s3_prefix", "").strip()

    if not folder_path_raw:
        return jsonify({"error": "folder_path is required"}), 400
    folder = _resolve_folder_path(Path(folder_path_raw))
    if not folder.is_dir():
        return jsonify({"error": f"folder_path does not exist: {folder}"}), 400

    # str at the serialization boundary: the subprocess command, the SyncJob record,
    # and the JSON logs all store the path as text.
    folder_path = str(folder)
    if not s3_prefix:
        return jsonify({"error": "s3_prefix is required"}), 400

    settings = get_settings()
    if not settings.s3_bucket:
        return jsonify({"error": "S3 bucket not configured. Check Settings."}), 400

    s3_uri = f"s3://{settings.s3_bucket}/{s3_prefix.strip('/')}/"

    cmd_base = [
        "aws",
        "s3",
        "sync",
        folder_path,
        s3_uri,
        "--no-progress",
        "--region",
        settings.aws_region,
    ]
    if settings.aws_profile and settings.aws_profile != "default":
        cmd_base += ["--profile", settings.aws_profile]

    # Verify aws CLI is available before creating the job
    try:
        subprocess.run(["aws", "--version"], capture_output=True, check=True, timeout=5)
    except (FileNotFoundError, subprocess.CalledProcessError):
        return jsonify({"error": "aws CLI not found. Install the AWS CLI and try again."}), 500

    job_id = str(uuid.uuid4())
    job = SyncJob(
        job_id=job_id,
        folder_path=folder_path,
        s3_prefix=s3_prefix,
        s3_uri=s3_uri,
        cmd_base=cmd_base,
    )
    _register(job)

    # Log the start
    try:
        from app.services.log_service import get_log_service

        get_log_service().info(
            "large_folder_sync",
            "sync_started",
            f"Large folder sync started: {folder_path} → {s3_uri}",
            {"job_id": job_id, "folder_path": folder_path, "s3_uri": s3_uri},
        )
    except Exception:
        pass

    thread = threading.Thread(target=_stream_process, args=(job,), daemon=True)
    thread.start()

    cmd_display = " ".join(cmd_base)
    return jsonify({"job_id": job_id, "s3_uri": s3_uri, "cmd": cmd_display}), 202


@large_folder_upload_bp.route("/progress/<job_id>", methods=["GET"])
def stream_progress(job_id: str) -> Response:
    """SSE stream of aws s3 sync output lines for a job."""

    def generate() -> Generator[str, None, None]:
        sse_mgr = get_sse_manager()
        queue, event = sse_mgr.register_client(job_id)
        try:
            job = _get(job_id)
            if not job:
                yield f"data: {json.dumps({'error': 'Job not found'})}\n\n"
                return

            # Replay lines already captured before client connected
            for line in list(job.lines):
                yield f"data: {json.dumps({'type': 'line', 'line': line})}\n\n"

            # If job already finished before the SSE connection opened, send done immediately
            if job.status in ("completed", "failed", "cancelled"):
                done_payload = {
                    "type": "done",
                    "status": job.status,
                    "return_code": job.return_code,
                }
                yield f"data: {json.dumps(done_payload)}\n\n"
                return

            last_heartbeat = time.time()
            while True:
                while queue:
                    data = queue.popleft()
                    yield f"data: {json.dumps(data)}\n\n"
                    last_heartbeat = time.time()
                    if data.get("type") == "done":
                        return

                now = time.time()
                if now - last_heartbeat > sse_mgr.heartbeat_interval:
                    yield ": heartbeat\n\n"
                    last_heartbeat = now

                event.wait(timeout=sse_mgr.heartbeat_interval)
                event.clear()

                # Re-check job existence
                if not _get(job_id):
                    yield f"data: {json.dumps({'error': 'Job not found'})}\n\n"
                    return
        finally:
            sse_mgr.deregister_client(job_id, queue)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@large_folder_upload_bp.route("/cancel/<job_id>", methods=["POST"])
def cancel_sync(job_id: str) -> tuple[Response, int]:
    """Cancel a running sync job."""
    job = _get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    if job.status != "running":
        return jsonify({"message": "Job is not running", "status": job.status}), 200

    job.status = "cancelled"
    if job.process and job.process.poll() is None:
        job.process.terminate()
        try:
            job.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            job.process.kill()

    get_sse_manager().send_event(
        job_id,
        {"type": "done", "status": "cancelled", "return_code": None},
    )
    return jsonify({"job_id": job_id, "status": "cancelled"}), 200
