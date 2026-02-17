"""Delete API routes for local file cleanup after S3 upload."""

import json
import threading
import time
from collections import deque
from collections.abc import Generator
from pathlib import Path
from typing import Any

from flask import Blueprint, Response, jsonify, request

from app.config import get_settings
from app.services.delete_manager import DeleteJob, get_delete_manager

delete_bp = Blueprint("delete", __name__)

# SSE client queues for delete jobs
_sse_queues: dict[str, list[deque[dict[str, Any]]]] = {}
_sse_lock = threading.Lock()


def _send_sse_event(job_id: str, data: dict[str, Any]) -> None:
    """Send an SSE event to all clients listening for a delete job."""
    with _sse_lock:
        queues = _sse_queues.get(job_id, [])
        for q in queues:
            q.append(data)


@delete_bp.route("/scan", methods=["POST"])
def scan_folder() -> tuple[Response, int]:
    """Scan a folder for deletable MCAP files.

    Cross-references local .mcap files with the upload cache to find
    files that have been uploaded to S3.

    Request body:
        folder_path: Path to scan for MCAP files

    Returns:
        JSON with job_id, matched files, and stats
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

    settings = get_settings()
    manager = get_delete_manager()

    try:
        job = manager.scan_folder(str(folder_path.absolute()), settings.s3_bucket)
    except PermissionError as e:
        return jsonify({"error": f"Permission denied: {e}"}), 403

    total_size = sum(f.file_size for f in job.files)

    return jsonify({
        "success": True,
        "job_id": job.job_id,
        "folder_path": str(folder_path.absolute()),
        "files": [f.to_dict() for f in job.files],
        "total_files": len(job.files),
        "total_size": total_size,
    }), 200


@delete_bp.route("/start/<job_id>", methods=["POST"])
def start_delete(job_id: str) -> tuple[Response, int]:
    """Start verification and deletion for a delete job.

    Args:
        job_id: The delete job to start

    Returns:
        JSON with job status
    """
    settings = get_settings()
    manager = get_delete_manager()

    job = manager.get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    def progress_callback(job: DeleteJob) -> None:
        """Send progress updates via SSE."""
        if job.status in ("completed", "failed", "cancelled"):
            _send_sse_event(job.job_id, {"type": "delete_complete", **job.to_dict()})
        else:
            _send_sse_event(
                job.job_id, {"type": "delete_progress", **job.to_progress_dict()}
            )

    def run_delete() -> None:
        manager.start_delete_job(
            job_id,
            settings.aws_profile,
            settings.aws_region,
            progress_callback=progress_callback,
        )

    thread = threading.Thread(target=run_delete, daemon=True)
    thread.start()

    return jsonify({"job_id": job_id, "status": "started"}), 200


@delete_bp.route("/progress/<job_id>", methods=["GET"])
def get_progress(job_id: str) -> Response:
    """Stream progress updates for a delete job via SSE.

    Args:
        job_id: The delete job to monitor

    Returns:
        SSE stream of progress updates
    """
    manager = get_delete_manager()

    def generate() -> Generator[str, None, None]:
        queue: deque[dict[str, Any]] = deque()
        with _sse_lock:
            if job_id not in _sse_queues:
                _sse_queues[job_id] = []
            _sse_queues[job_id].append(queue)

        try:
            # Send initial state
            job = manager.get_job(job_id)
            if job:
                yield f"data: {json.dumps(job.to_progress_dict())}\n\n"

            while True:
                while queue:
                    data = queue.popleft()
                    yield f"data: {json.dumps(data)}\n\n"

                    # Terminal events
                    if data.get("type") == "delete_complete":
                        return

                time.sleep(0.1)

                # Check if job still exists
                job = manager.get_job(job_id)
                if not job:
                    yield 'data: {"error": "Job not found"}\n\n'
                    return

                # Handle race: job completed before client connected
                if job.status in ("completed", "failed", "cancelled"):
                    yield f"data: {json.dumps({'type': 'delete_complete', **job.to_dict()})}\n\n"
                    return

        finally:
            with _sse_lock:
                if job_id in _sse_queues and queue in _sse_queues[job_id]:
                    _sse_queues[job_id].remove(queue)
                    if not _sse_queues[job_id]:
                        del _sse_queues[job_id]

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@delete_bp.route("/status/<job_id>", methods=["GET"])
def get_status(job_id: str) -> tuple[Response, int]:
    """Get current status of a delete job (non-streaming).

    Args:
        job_id: The delete job to check

    Returns:
        JSON with job status
    """
    manager = get_delete_manager()

    job = manager.get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    return jsonify(job.to_dict()), 200


@delete_bp.route("/cancel/<job_id>", methods=["POST"])
def cancel_delete(job_id: str) -> tuple[Response, int]:
    """Cancel a delete job.

    Args:
        job_id: The delete job to cancel

    Returns:
        JSON with cancellation status
    """
    manager = get_delete_manager()

    if manager.cancel_job(job_id):
        job = manager.get_job(job_id)
        return jsonify({
            "success": True,
            "job_id": job_id,
            "job": job.to_dict() if job else None,
        }), 200

    return jsonify({"error": "Job not found"}), 404
