"""Upload API routes for modaq_upload"""

import json
import tempfile
import threading
import time
from collections import deque
from collections.abc import Callable, Generator
from pathlib import Path
from typing import Any

from flask import Blueprint, Response, jsonify, request

from app.config import get_settings
from app.services.upload_manager import (
    FileUploadState,
    UploadJob,
    UploadStatus,
    get_upload_manager,
)

upload_bp = Blueprint("upload", __name__)

# Store for SSE clients per job
_sse_queues: dict[str, list[deque[dict[str, Any]]]] = {}
_sse_lock = threading.Lock()


def send_sse_event(job_id: str, data: dict[str, Any]) -> None:
    """Send an SSE event to all clients listening for a job."""
    with _sse_lock:
        queues = _sse_queues.get(job_id, [])
        for q in queues:
            q.append(data)


def _make_analysis_callback(
    job_id: str,
) -> Callable[[UploadJob, FileUploadState], None]:
    """Create an analysis progress callback that sends SSE events."""

    def callback(job: UploadJob, file_state: FileUploadState) -> None:
        send_sse_event(
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
            send_sse_event(
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
            "files": [f.to_dict() for f in job.files],
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

    def progress_callback(job: UploadJob) -> None:
        """Send progress updates via SSE."""
        send_sse_event(job.job_id, job.to_dict())

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

    Args:
        job_id: The job ID to monitor

    Returns:
        SSE stream of progress updates
    """
    manager = get_upload_manager()

    def generate() -> Generator[str, None, None]:
        # Create a queue for this client
        queue: deque[dict[str, Any]] = deque()
        with _sse_lock:
            if job_id not in _sse_queues:
                _sse_queues[job_id] = []
            _sse_queues[job_id].append(queue)

        try:
            # Send initial state
            job = manager.get_job(job_id)
            if job:
                yield f"data: {json.dumps(job.to_dict())}\n\n"

            # Stream updates
            while True:
                # Check for updates
                while queue:
                    data = queue.popleft()
                    yield f"data: {json.dumps(data)}\n\n"

                    # Check if job is complete
                    if data.get("status") in ("completed", "failed", "cancelled"):
                        return

                # Small delay to prevent busy waiting
                time.sleep(0.1)

                # Check if job still exists
                job = manager.get_job(job_id)
                if not job:
                    yield 'data: {"error": "Job not found"}\n\n'
                    return

        finally:
            # Clean up queue
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

    # When force-reuploading, analyze ALL files (not just non-duplicates)
    job_files = file_paths if not skip_duplicates else files_to_analyze

    # Create job with files that need analysis (no temp_dir - direct file access)
    job = manager.create_job(job_files, auto_upload=auto_upload)
    job.pre_filter_stats = pre_filter_stats
    analysis_progress_callback = _make_analysis_callback(job.job_id)

    def upload_progress_callback(job: UploadJob) -> None:
        """Send upload progress updates via SSE."""
        send_sse_event(job.job_id, job.to_dict())

    # Start analysis in background thread
    def run_bulk_analysis() -> None:
        manager.analyze_job_async(
            job.job_id,
            settings.aws_profile,
            settings.aws_region,
            settings.s3_bucket,
            progress_callback=analysis_progress_callback,
        )

        # Send analysis complete event
        final_job = manager.get_job(job.job_id)
        if final_job:
            send_sse_event(
                job.job_id,
                {
                    "type": "analysis_complete",
                    "job": final_job.to_dict(),
                    "auto_upload": final_job.auto_upload,
                },
            )

            # Auto-upload if enabled and analysis succeeded
            if final_job.auto_upload and final_job.status == UploadStatus.READY:
                send_sse_event(
                    job.job_id,
                    {
                        "type": "auto_upload_starting",
                        "job_id": job.job_id,
                    },
                )
                manager.start_upload(
                    job.job_id,
                    settings.aws_profile,
                    settings.aws_region,
                    settings.s3_bucket,
                    skip_duplicates=skip_duplicates,
                    progress_callback=upload_progress_callback,
                )
            elif final_job.auto_upload:
                # All files failed analysis — send terminal status so frontend doesn't hang
                send_sse_event(job.job_id, final_job.to_dict())

    thread = threading.Thread(target=run_bulk_analysis, daemon=True)
    thread.start()

    return jsonify(
        {
            "job_id": job.job_id,
            "status": "analyzing",
            "total_files": len(job.files),
            "pre_filter_stats": pre_filter_stats,
            "auto_upload": auto_upload,
            "files": [f.to_dict() for f in job.files],
        }
    ), 202
