"""Upload API routes for modaq_upload"""

import json
import tempfile
import threading
import time
from collections.abc import Callable, Generator
from pathlib import Path
from typing import Any

from flask import Blueprint, Response, jsonify, request

from app.config import get_settings
from app.services.sse_manager import get_sse_manager
from app.services.upload_manager import (
    FileUploadState,
    UploadJob,
    UploadStatus,
    get_upload_manager,
)

upload_bp = Blueprint("upload", __name__)


def _make_analysis_callback(
    job_id: str,
) -> Callable[[UploadJob, FileUploadState], None]:
    """Create an analysis progress callback that sends SSE events."""

    def callback(job: UploadJob, file_state: FileUploadState) -> None:
        get_sse_manager().send_event(
            job_id,
            {
                "type": "analysis_progress",
                "job_id": job.job_id,
                "job_status": job.status.value,
                "file": file_state.to_dict(),
                "total_files": len(job.files),
                "analysis_complete": job.status.value in ("ready", "failed"),
            },
        )

    return callback


# 4 Hz cap on non-terminal progress events. The S3 byte_callback fires per chunk
# (~1 M times across a 1 TB upload); without throttling we would emit ~1 M SSE
# events. Terminal events (COMPLETED / FAILED / CANCELLED) always bypass the
# throttle so the frontend never misses the final state.
SSE_EMIT_INTERVAL_SECONDS = 0.25
_TERMINAL_JOB_STATUSES = (
    UploadStatus.COMPLETED,
    UploadStatus.FAILED,
    UploadStatus.CANCELLED,
)


def _make_throttled_progress_callback(
    large_job_threshold: int | None = None,
) -> Callable[[UploadJob], None]:
    """Create a progress callback that coalesces SSE events at 4 Hz.

    Terminal events always emit. Closure-local state means each job gets its
    own throttle window — safe to share across threads since callers hold
    ``job._progress_lock`` for the check-and-stamp.
    """

    def progress_callback(job: UploadJob) -> None:
        is_terminal = job.status in _TERMINAL_JOB_STATUSES
        if not is_terminal:
            now = time.monotonic()
            with job._progress_lock:
                if (now - job._last_emit_ts) < SSE_EMIT_INTERVAL_SECONDS:
                    return
                job._last_emit_ts = now

        sse = get_sse_manager()
        if is_terminal:
            # Large jobs read per-file results from /api/upload/results (SQLite-backed)
            # rather than receiving a 10k-row payload here. Small jobs keep the
            # legacy behavior — frontend merges the full file array directly.
            if (
                large_job_threshold is not None
                and len(job.files) >= large_job_threshold
            ):
                payload = job.to_progress_dict()
                payload["terminal"] = True
                sse.send_event(job.job_id, payload)
            else:
                sse.send_event(job.job_id, job.to_dict())
        else:
            sse.send_event(job.job_id, job.to_progress_dict())

    return progress_callback


def _large_job_threshold() -> int:
    """Read the live setting for the large-job cutoff."""
    return int(
        get_settings().batch_processing.get("large_job_threshold", 1000)
    )


@upload_bp.route("/analyze", methods=["POST"])
def analyze_files() -> tuple[Response, int]:
    """Analyze uploaded files and prepare for upload.

    Accepts multipart/form-data with files or JSON with file paths.
    Returns immediately with job_id (202 Accepted) and analyzes in background.
    Progress updates are sent via SSE on /api/upload/progress/<job_id>.

    Returns:
        JSON response with job_id and initial status (202 Accepted)
    """
    settings = get_settings()
    manager = get_upload_manager()

    file_paths: list[str] = []
    temp_dir: str | None = None

    # Handle file uploads (multipart/form-data)
    if request.files:
        uploaded_files = request.files.getlist("files")
        # Create a single temp directory for all files in this upload
        temp_dir = tempfile.mkdtemp(prefix="mcap_upload_")
        for uploaded_file in uploaded_files:
            if uploaded_file.filename:
                # Filename may include subdirectory path from folder selection
                temp_path = Path(temp_dir) / uploaded_file.filename
                temp_path.parent.mkdir(parents=True, exist_ok=True)
                uploaded_file.save(temp_path)
                file_paths.append(str(temp_path))

    # Handle JSON with file paths (for folder selection / bulk mode)
    elif request.is_json:
        data = request.get_json()
        if data and "file_paths" in data:
            file_paths = data["file_paths"]
            # No temp_dir when using JSON paths - files read directly from source

    if not file_paths:
        return jsonify({"error": "No files provided"}), 400

    # Create job with temp_dir tracked for cleanup
    job = manager.create_job(file_paths, temp_dir=temp_dir)
    analysis_progress_callback = _make_analysis_callback(job.job_id)

    # Start analysis in background thread
    def run_analysis() -> None:
        manager.analyze_job_async(
            job.job_id,
            settings.aws_profile,
            settings.aws_region,
            settings.s3_bucket,
            progress_callback=analysis_progress_callback,
        )
        # Send final job state when analysis completes
        final_job = manager.get_job(job.job_id)
        if final_job:
            get_sse_manager().send_event(
                job.job_id,
                {
                    "type": "analysis_complete",
                    "job": final_job.to_dict(),
                },
            )

    thread = threading.Thread(target=run_analysis, daemon=True)
    thread.start()

    # Return immediately with job info
    return jsonify(
        {
            "job_id": job.job_id,
            "status": "analyzing",
            "total_files": len(job.files),
        }
    ), 202


@upload_bp.route("/start/<job_id>", methods=["POST"])
def start_upload(job_id: str) -> tuple[Response, int]:
    """Start uploading files for a job.

    Args:
        job_id: The job ID to start uploading

    Request body (optional):
        skip_duplicates: Whether to skip duplicate files (default: true)

    Returns:
        JSON response with job status
    """
    settings = get_settings()
    manager = get_upload_manager()

    job = manager.get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    # Get options from request
    skip_duplicates = True
    if request.is_json:
        data = request.get_json()
        if data:
            skip_duplicates = data.get("skip_duplicates", True)

    progress_callback = _make_throttled_progress_callback(_large_job_threshold())

    # Start upload in background thread
    def run_upload() -> None:
        manager.start_upload(
            job_id,
            settings.aws_profile,
            settings.aws_region,
            settings.s3_bucket,
            skip_duplicates=skip_duplicates,
            progress_callback=progress_callback,
        )

    thread = threading.Thread(target=run_upload, daemon=True)
    thread.start()

    return jsonify({"job_id": job_id, "status": "started"}), 200


@upload_bp.route("/progress/<job_id>", methods=["GET"])
def get_progress(job_id: str) -> Response:
    """Stream progress updates for a job via Server-Sent Events.

    Uses event-driven signaling (instead of polling) and periodic heartbeats
    to efficiently detect client disconnects.

    Args:
        job_id: The job ID to monitor

    Returns:
        SSE stream of progress updates
    """
    manager = get_upload_manager()

    def generate() -> Generator[str, None, None]:
        # Register this client with the SSE manager
        sse_mgr = get_sse_manager()
        queue, event = sse_mgr.register_client(job_id)

        # Periodic cleanup of old queues
        sse_mgr.cleanup_old_queues()

        try:
            # Send initial state
            job = manager.get_job(job_id)
            scan_job = manager.get_scan_job(job_id) if not job else None
            if job:
                if job.status in (
                    UploadStatus.COMPLETED,
                    UploadStatus.FAILED,
                    UploadStatus.CANCELLED,
                ):
                    yield f"data: {json.dumps(job.to_dict())}\n\n"
                else:
                    yield f"data: {json.dumps(job.to_progress_dict())}\n\n"
                    # Replay per-file states for files already past PENDING.
                    # Covers the race window where ANALYZING events fired
                    # before the EventSource connected.
                    analysis_complete = job.status.value in ("ready", "failed")
                    for fs in job.files:
                        if fs.status != UploadStatus.PENDING:
                            replay = {
                                "type": "analysis_progress",
                                "job_id": job.job_id,
                                "job_status": job.status.value,
                                "file": fs.to_dict(),
                                "total_files": len(job.files),
                                "analysis_complete": analysis_complete,
                            }
                            yield f"data: {json.dumps(replay)}\n\n"
            elif scan_job:
                if scan_job.status in ("completed", "failed", "cancelled"):
                    # Fast/cached scan completed before this EventSource connected —
                    # all SSE events were sent to an empty queue and dropped.
                    # Replay the full results immediately so the frontend never waits
                    # for the 15-second heartbeat timeout.
                    for folder_data in scan_job.scanned_folders:
                        replay_event = {
                            "type": "scan_folder_complete",
                            "folder": folder_data,
                            "folders_scanned": scan_job.folders_scanned,
                            "folders_total": scan_job.folders_total,
                            "running_totals": {
                                "total_files_found": scan_job.total_files_found,
                                "total_already_uploaded": scan_job.total_already_uploaded,
                                "total_size": scan_job.total_size,
                            },
                        }
                        yield f"data: {json.dumps(replay_event)}\n\n"
                    terminal_data = {
                        "type": "scan_complete",
                        "status": scan_job.status,
                        "folders_scanned": scan_job.folders_scanned,
                        "folders_total": scan_job.folders_total,
                        "total_files_found": scan_job.total_files_found,
                        "total_already_uploaded": scan_job.total_already_uploaded,
                        "total_size": scan_job.total_size,
                    }
                    yield f"data: {json.dumps(terminal_data)}\n\n"
                    return
                else:
                    initial = {"type": "scan_initial", "status": scan_job.status}
                    yield f"data: {json.dumps(initial)}\n\n"

            last_heartbeat_time = time.time()

            # Stream updates with event-driven waiting (no polling)
            while True:
                # Process all queued events
                while queue:
                    data = queue.popleft()
                    yield f"data: {json.dumps(data)}\n\n"
                    last_heartbeat_time = time.time()

                    # Check if job is complete (upload jobs)
                    if data.get("status") in ("completed", "failed", "cancelled"):
                        # For scan events, check the type field
                        if data.get("type") == "scan_complete":
                            return
                        # For upload jobs (no type field)
                        if not data.get("type"):
                            return

                # Send heartbeat if no activity for a while
                now = time.time()
                if now - last_heartbeat_time > sse_mgr.heartbeat_interval:
                    yield ": heartbeat\n\n"  # Comment line, ignored by EventSource
                    last_heartbeat_time = now

                # Wait for signal (blocking, no CPU waste) with timeout for heartbeat
                event.wait(timeout=sse_mgr.heartbeat_interval)
                event.clear()

                # Check if job still exists (upload or scan)
                job = manager.get_job(job_id)
                scan_job = manager.get_scan_job(job_id) if not job else None
                if not job and not scan_job:
                    yield 'data: {"error": "Job not found"}\n\n'
                    return

                # Check if scan job reached terminal state before client connected
                # (race condition: fast scans finish before EventSource opens,
                # so events were sent to empty queues and dropped)
                if scan_job and scan_job.status in (
                    "completed",
                    "failed",
                    "cancelled",
                ):
                    # Replay missed folder results so frontend gets the data
                    for folder_data in scan_job.scanned_folders:
                        replay_event = {
                            "type": "scan_folder_complete",
                            "folder": folder_data,
                            "folders_scanned": scan_job.folders_scanned,
                            "folders_total": scan_job.folders_total,
                            "running_totals": {
                                "total_files_found": scan_job.total_files_found,
                                "total_already_uploaded": scan_job.total_already_uploaded,
                                "total_size": scan_job.total_size,
                            },
                        }
                        yield f"data: {json.dumps(replay_event)}\n\n"

                    terminal_data = {
                        "type": "scan_complete",
                        "status": scan_job.status,
                        "folders_scanned": scan_job.folders_scanned,
                        "folders_total": scan_job.folders_total,
                        "total_files_found": scan_job.total_files_found,
                        "total_already_uploaded": scan_job.total_already_uploaded,
                        "total_size": scan_job.total_size,
                    }
                    yield f"data: {json.dumps(terminal_data)}\n\n"
                    return

        finally:
            sse_mgr.deregister_client(job_id, queue)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@upload_bp.route("/status/<job_id>", methods=["GET"])
def get_status(job_id: str) -> tuple[Response, int]:
    """Get current status of a job (non-streaming).

    Args:
        job_id: The job ID to check

    Returns:
        JSON response with job status
    """
    manager = get_upload_manager()

    job = manager.get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    return jsonify(job.to_dict()), 200


@upload_bp.route("/results/<job_id>", methods=["GET"])
def get_results(job_id: str) -> tuple[Response, int]:
    """Get paginated results for a completed job.

    For large jobs (>1000 files), results are stored in database and retrieved
    in pages to prevent memory overload and large response payloads.

    Args:
        job_id: The job ID to get results for

    Query parameters:
        page: Page number (default: 1)
        per_page: Results per page (default: 100, max: 500)

    Returns:
        JSON response with paginated file results and job metadata
    """
    from app.services.job_storage import get_job_storage

    manager = get_upload_manager()
    storage = get_job_storage()

    # Try to get from database first (for large jobs)
    db_job = storage.get_job(job_id)
    if db_job:
        page = request.args.get("page", 1, type=int)
        per_page = min(request.args.get("per_page", 100, type=int), 500)

        results = storage.get_job_results(job_id, page=page, per_page=per_page)
        results["job_metadata"] = db_job
        return jsonify(results), 200

    # Fall back to in-memory job (for small jobs)
    job = manager.get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    # Return in-memory job with all files (small jobs only)
    return jsonify(
        {
            "job_id": job_id,
            "files": [f.to_dict() for f in job.files],
            "pagination": {
                "page": 1,
                "per_page": len(job.files),
                "total_files": len(job.files),
                "total_pages": 1,
                "has_next": False,
                "has_prev": False,
            },
            "job_metadata": {
                "job_id": job.job_id,
                "status": job.status.value,
                "total_files": len(job.files),
                "files_uploaded": sum(1 for f in job.files if f.status == UploadStatus.COMPLETED),
                "files_failed": job.files_failed,
                "total_bytes": job.total_bytes,
            },
        }
    ), 200


@upload_bp.route("/active", methods=["GET"])
def get_active_job() -> tuple[Response, int]:
    """Get the most recent active job (for state restoration on page refresh).

    Returns:
        JSON response with active job_id and job data, or empty if no active job
    """
    manager = get_upload_manager()

    # Find the most recent job that is still active (not completed/failed/cancelled)
    active_jobs = manager.get_active_jobs()
    active_job: UploadJob | None = None
    for job in active_jobs:
        if active_job is None or job.job_id > active_job.job_id:
            active_job = job

    if active_job:
        return jsonify(
            {
                "job_id": active_job.job_id,
                "job": active_job.to_dict(),
            }
        ), 200
    else:
        return jsonify({"job_id": None, "job": None}), 200


@upload_bp.route("/cleanup-sse", methods=["POST"])
def cleanup_sse_queues() -> tuple[Response, int]:
    """Clean up stale SSE queues and events.

    This can be called periodically or manually to reclaim memory from
    abandoned connections. Returns the number of queues removed.

    Returns:
        JSON response with cleanup statistics
    """
    removed = get_sse_manager().cleanup_old_queues()
    return jsonify(
        {
            "success": True,
            "queues_removed": removed,
            "active_queues": get_sse_manager().queue_count,
            "ttl_seconds": get_sse_manager().ttl_seconds,
        }
    ), 200


@upload_bp.route("/cancel/<job_id>", methods=["POST"])
def cancel_upload(job_id: str) -> tuple[Response, int]:
    """Cancel an upload job.

    Args:
        job_id: The job ID to cancel

    Returns:
        JSON response with cancellation status
    """
    manager = get_upload_manager()

    if manager.cancel_job(job_id):
        job = manager.get_job(job_id)
        return jsonify(
            {
                "success": True,
                "job_id": job_id,
                "job": job.to_dict() if job else None,
            }
        ), 200
    elif manager.cancel_scan_job(job_id):
        return jsonify({"success": True, "job_id": job_id}), 200
    else:
        return jsonify({"error": "Job not found"}), 404


@upload_bp.route("/scan-folder", methods=["POST"])
def scan_folder() -> tuple[Response, int]:
    """Scan a folder for MCAP files without copying.

    Request body:
        folder_path: Path to the folder to scan

    Returns:
        JSON response with list of files found
    """
    if not request.is_json:
        return jsonify({"error": "JSON body required"}), 400

    data = request.get_json()
    if not data or "folder_path" not in data:
        return jsonify({"error": "folder_path is required"}), 400

    folder_path = Path(data["folder_path"])

    if not folder_path.exists():
        return jsonify({"error": f"Folder not found: {folder_path}"}), 404

    if not folder_path.is_dir():
        return jsonify({"error": f"Path is not a directory: {folder_path}"}), 400

    # Recursively find all .mcap files
    files: list[dict[str, Any]] = []
    total_size = 0
    try:
        for mcap_path in folder_path.rglob("*.mcap"):
            if mcap_path.is_file():
                stat = mcap_path.stat()
                file_size = stat.st_size
                total_size += file_size
                files.append(
                    {
                        "path": str(mcap_path.absolute()),
                        "filename": mcap_path.name,
                        "size": file_size,
                        "mtime": stat.st_mtime,
                        "relative_path": str(mcap_path.relative_to(folder_path)),
                    }
                )
    except PermissionError as e:
        return jsonify({"error": f"Permission denied: {e}"}), 403

    return jsonify(
        {
            "success": True,
            "folder_path": str(folder_path.absolute()),
            "files": files,
            "total_count": len(files),
            "total_size": total_size,
        }
    ), 200


@upload_bp.route("/scan-folder-async", methods=["POST"])
def scan_folder_async() -> tuple[Response, int]:
    """Start an async folder scan that streams results via SSE.

    Request body:
        folder_path: Path to the folder to scan

    Returns:
        JSON response with job_id (202 Accepted)
    """
    if not request.is_json:
        return jsonify({"error": "JSON body required"}), 400

    data = request.get_json()
    if not data or "folder_path" not in data:
        return jsonify({"error": "folder_path is required"}), 400

    folder_path = Path(data["folder_path"])

    if not folder_path.exists():
        return jsonify({"error": f"Folder not found: {folder_path}"}), 404

    if not folder_path.is_dir():
        return jsonify({"error": f"Path is not a directory: {folder_path}"}), 400

    cache_only: bool = data.get("cache_only", False)
    excluded_subfolders: list[str] = data.get("excluded_subfolders", [])
    excluded_files: list[str] = data.get("excluded_files", [])

    settings = get_settings()
    manager = get_upload_manager()

    scan_job = manager.create_scan_job(
        str(folder_path.absolute()),
        excluded_subfolders=excluded_subfolders,
        excluded_files=excluded_files,
    )

    def scan_progress_callback(job_id: str, event_data: dict[str, Any]) -> None:
        get_sse_manager().send_event(job_id, event_data)

    def run_scan() -> None:
        manager.scan_folder_async(
            scan_job.job_id,
            settings.s3_bucket,
            settings.aws_profile,
            settings.aws_region,
            progress_callback=scan_progress_callback,
            cache_only=cache_only,
        )

    thread = threading.Thread(target=run_scan, daemon=True)
    thread.start()

    return jsonify(
        {
            "job_id": scan_job.job_id,
            "status": "scanning",
        }
    ), 202


@upload_bp.route("/bulk-analyze", methods=["POST"])
def bulk_analyze() -> tuple[Response, int]:
    """Bulk analyze files with pre-filtering and optional auto-upload.

    This endpoint is designed for bulk uploads from external drives.
    Files are read directly from source (no copying to temp storage).

    Request body:
        file_paths: List of file paths to analyze
        auto_upload: Whether to auto-start upload for valid files (default: false)
        pre_filter_only: If true, only return pre-filter stats without analysis

    Returns:
        JSON response with job_id and pre-filter stats (202 Accepted)
    """
    if not request.is_json:
        return jsonify({"error": "JSON body required"}), 400

    data = request.get_json()
    if not data or "file_paths" not in data:
        return jsonify({"error": "file_paths is required"}), 400

    file_paths: list[str] = data["file_paths"]
    auto_upload: bool = data.get("auto_upload", False)
    pre_filter_only: bool = data.get("pre_filter_only", False)
    skip_duplicates: bool = data.get("skip_duplicates", True)

    if not file_paths:
        return jsonify({"error": "No files provided"}), 400

    settings = get_settings()
    manager = get_upload_manager()

    # Run pre-filtering (with S3 fallback for cache misses)
    files_to_analyze, pre_filter_stats = manager.pre_filter_files(
        file_paths, settings.s3_bucket, settings.aws_profile, settings.aws_region
    )

    if pre_filter_only:
        return jsonify(
            {
                "success": True,
                "pre_filter_stats": pre_filter_stats,
                "files_to_analyze": len(files_to_analyze),
            }
        ), 200

    # Always include all user-selected files in the job. The pipeline marks
    # already-uploaded files as "skipped" when skip_duplicates=True rather than
    # silently dropping them — an empty job_files here causes a 0-file job that
    # completes instantly and bypasses the upload screen entirely.
    job_files = file_paths

    # Create job with files that need analysis (no temp_dir - direct file access)
    job = manager.create_job(job_files, auto_upload=auto_upload)
    job.pre_filter_stats = pre_filter_stats
    analysis_progress_callback = _make_analysis_callback(job.job_id)

    upload_progress_callback = _make_throttled_progress_callback(_large_job_threshold())

    # Start in background thread
    def run_bulk_job() -> None:
        if auto_upload:
            # Pipeline: analyze each file and upload immediately as it's ready.
            # Uploads start flowing while remaining files are still being parsed.
            manager.analyze_and_upload_pipeline(
                job.job_id,
                settings.aws_profile,
                settings.aws_region,
                settings.s3_bucket,
                skip_duplicates=skip_duplicates,
                analysis_callback=analysis_progress_callback,
                upload_callback=upload_progress_callback,
            )
        else:
            # Analysis only — user will review results before starting upload.
            manager.analyze_job_async(
                job.job_id,
                settings.aws_profile,
                settings.aws_region,
                settings.s3_bucket,
                progress_callback=analysis_progress_callback,
            )
            final_job = manager.get_job(job.job_id)
            if final_job:
                get_sse_manager().send_event(
                    job.job_id,
                    {
                        "type": "analysis_complete",
                        "job": final_job.to_dict(),
                        "auto_upload": False,
                    },
                )

    thread = threading.Thread(target=run_bulk_job, daemon=True)
    thread.start()

    return jsonify(
        {
            "job_id": job.job_id,
            "status": "analyzing",
            "total_files": len(job.files),
            "pre_filter_stats": pre_filter_stats,
            "auto_upload": auto_upload,
        }
    ), 202
