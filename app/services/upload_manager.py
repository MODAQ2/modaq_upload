"""Upload manager for orchestrating file uploads to S3."""

import logging
import shutil
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any

from app.services import mcap_service, s3_service
from app.services.cache_service import get_cache_service
from app.services.log_service import get_log_service
from app.services.utils import format_file_size

logger = logging.getLogger(__name__)

# Timestamps before this date are considered invalid (1970/epoch issues)
EPOCH_CUTOFF = datetime(1980, 1, 1, tzinfo=UTC)


class UploadStatus(Enum):
    """Status of a file upload."""

    PENDING = "pending"
    ANALYZING = "analyzing"
    READY = "ready"
    UPLOADING = "uploading"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"
    CANCELLED = "cancelled"


@dataclass
class FileUploadState:
    """State of a single file in an upload job."""

    filename: str
    local_path: str
    file_size: int
    status: UploadStatus = UploadStatus.PENDING
    s3_path: str = ""
    start_time: datetime | None = None  # MCAP file's data start time
    bytes_uploaded: int = 0
    error_message: str = ""
    is_duplicate: bool = False
    is_valid: bool = True  # False if timestamp is invalid (1970/epoch)
    upload_started_at: datetime | None = None  # When upload began
    upload_completed_at: datetime | None = None  # When upload finished

    @property
    def upload_duration_seconds(self) -> float | None:
        """Calculate upload duration in seconds."""
        if self.upload_started_at and self.upload_completed_at:
            return (self.upload_completed_at - self.upload_started_at).total_seconds()
        return None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        duration = self.upload_duration_seconds
        return {
            "filename": self.filename,
            "local_path": self.local_path,
            "file_size": self.file_size,
            "file_size_formatted": format_file_size(self.file_size),
            "status": self.status.value,
            "s3_path": self.s3_path,
            "start_time": self.start_time.isoformat() if self.start_time else None,
            "bytes_uploaded": self.bytes_uploaded,
            "progress_percent": round(
                (self.bytes_uploaded / self.file_size * 100) if self.file_size > 0 else 0, 1
            ),
            "error_message": self.error_message,
            "is_duplicate": self.is_duplicate,
            "is_valid": self.is_valid,
            "upload_started_at": (
                self.upload_started_at.isoformat() if self.upload_started_at else None
            ),
            "upload_completed_at": (
                self.upload_completed_at.isoformat() if self.upload_completed_at else None
            ),
            "upload_duration_seconds": duration,
            "upload_speed_mbps": (
                round(self.file_size / duration / 1024 / 1024 * 8, 2)
                if duration and duration > 0
                else None
            ),
        }


@dataclass
class UploadJob:
    """Represents an upload job containing multiple files."""

    job_id: str
    files: list[FileUploadState] = field(default_factory=list)
    status: UploadStatus = UploadStatus.PENDING
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    started_at: datetime | None = None
    completed_at: datetime | None = None
    cancelled: bool = False
    auto_upload: bool = False  # Auto-start upload when analysis completes
    temp_dir: str | None = None  # Temp directory for cleanup
    pre_filter_stats: dict[str, Any] = field(default_factory=dict)  # Pre-filter statistics
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def total_bytes(self) -> int:
        """Total bytes across all files."""
        return sum(f.file_size for f in self.files)

    @property
    def uploaded_bytes(self) -> int:
        """Total bytes uploaded across all files."""
        return sum(f.bytes_uploaded for f in self.files)

    @property
    def progress_percent(self) -> float:
        """Overall progress percentage."""
        if self.total_bytes == 0:
            return 0.0
        return round(self.uploaded_bytes / self.total_bytes * 100, 1)

    @property
    def files_completed(self) -> int:
        """Number of files completed."""
        return sum(
            1 for f in self.files if f.status in (UploadStatus.COMPLETED, UploadStatus.SKIPPED)
        )

    @property
    def files_failed(self) -> int:
        """Number of files failed."""
        return sum(1 for f in self.files if f.status == UploadStatus.FAILED)

    @property
    def eta_seconds(self) -> int | None:
        """Estimated time remaining in seconds."""
        if not self.started_at or self.uploaded_bytes == 0:
            return None

        elapsed = (datetime.now(UTC) - self.started_at).total_seconds()
        if elapsed <= 0:
            return None

        bytes_per_second = self.uploaded_bytes / elapsed
        remaining_bytes = self.total_bytes - self.uploaded_bytes

        if bytes_per_second <= 0:
            return None

        return int(remaining_bytes / bytes_per_second)

    @property
    def has_valid_uploadable_files(self) -> bool:
        """Check if there are any valid, non-duplicate files ready for upload."""
        return any(
            f.status == UploadStatus.READY and f.is_valid and not f.is_duplicate for f in self.files
        )

    @property
    def total_upload_duration_seconds(self) -> float | None:
        """Total upload duration from start to completion."""
        if self.started_at and self.completed_at:
            return (self.completed_at - self.started_at).total_seconds()
        return None

    @property
    def successfully_uploaded_bytes(self) -> int:
        """Total bytes from successfully uploaded files."""
        return sum(f.file_size for f in self.files if f.status == UploadStatus.COMPLETED)

    @property
    def average_upload_speed_mbps(self) -> float | None:
        """Average upload speed in Mbps."""
        duration = self.total_upload_duration_seconds
        if duration and duration > 0:
            return round(self.successfully_uploaded_bytes / duration / 1024 / 1024 * 8, 2)
        return None

    def resolve_analysis_status(self) -> None:
        """Set job status based on file analysis results."""
        if any(f.status == UploadStatus.READY for f in self.files):
            self.status = UploadStatus.READY
        else:
            self.status = UploadStatus.FAILED

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        duration = self.total_upload_duration_seconds
        return {
            "job_id": self.job_id,
            "status": self.status.value,
            "files": [f.to_dict() for f in self.files],
            "total_files": len(self.files),
            "files_completed": self.files_completed,
            "files_failed": self.files_failed,
            "files_skipped": sum(1 for f in self.files if f.status == UploadStatus.SKIPPED),
            "files_uploaded": sum(1 for f in self.files if f.status == UploadStatus.COMPLETED),
            "total_bytes": self.total_bytes,
            "total_bytes_formatted": format_file_size(self.total_bytes),
            "uploaded_bytes": self.uploaded_bytes,
            "uploaded_bytes_formatted": format_file_size(self.uploaded_bytes),
            "successfully_uploaded_bytes": self.successfully_uploaded_bytes,
            "successfully_uploaded_bytes_formatted": format_file_size(
                self.successfully_uploaded_bytes
            ),
            "progress_percent": self.progress_percent,
            "eta_seconds": self.eta_seconds,
            "created_at": self.created_at.isoformat(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "total_upload_duration_seconds": duration,
            "total_upload_duration_formatted": (
                f"{int(duration // 60)}m {int(duration % 60)}s" if duration else None
            ),
            "average_upload_speed_mbps": self.average_upload_speed_mbps,
            "cancelled": self.cancelled,
            "auto_upload": self.auto_upload,
            "has_valid_uploadable_files": self.has_valid_uploadable_files,
            "pre_filter_stats": self.pre_filter_stats,
        }


class UploadManager:
    """Manages upload jobs and their execution."""

    def __init__(self, max_workers: int = 4) -> None:
        self.jobs: dict[str, UploadJob] = {}
        self.max_workers = max_workers
        self._lock = threading.Lock()

    def create_job(
        self,
        file_paths: list[str],
        auto_upload: bool = False,
        temp_dir: str | None = None,
    ) -> UploadJob:
        """Create a new upload job with the specified files.

        Args:
            file_paths: List of local file paths to upload
            auto_upload: Whether to auto-start upload after analysis completes
            temp_dir: Optional temp directory to track for cleanup

        Returns:
            The created UploadJob
        """
        job_id = str(uuid.uuid4())
        job = UploadJob(job_id=job_id, auto_upload=auto_upload, temp_dir=temp_dir)

        for path_str in file_paths:
            path = Path(path_str)
            if path.exists():
                file_state = FileUploadState(
                    filename=path.name,
                    local_path=str(path.absolute()),
                    file_size=path.stat().st_size,
                )
                job.files.append(file_state)

        with self._lock:
            self.jobs[job_id] = job

        log = get_log_service()
        log.info(
            "upload",
            "upload_job_created",
            f"Created upload job with {len(job.files)} files",
            {
                "job_id": job_id,
                "total_files": len(job.files),
                "total_bytes": job.total_bytes,
                "auto_upload": auto_upload,
            },
        )

        return job

    def get_job(self, job_id: str) -> UploadJob | None:
        """Get a job by ID."""
        return self.jobs.get(job_id)

    def analyze_job(
        self,
        job_id: str,
        aws_profile: str,
        aws_region: str,
        s3_bucket: str,
    ) -> UploadJob | None:
        """Analyze files in a job - extract timestamps and check for duplicates.

        Args:
            job_id: The job ID to analyze
            aws_profile: AWS profile to use
            aws_region: AWS region
            s3_bucket: S3 bucket to check for duplicates

        Returns:
            The updated UploadJob or None if not found
        """
        job = self.get_job(job_id)
        if not job:
            return None

        job.status = UploadStatus.ANALYZING

        # Create S3 client for duplicate checking
        try:
            s3_client = s3_service.create_s3_client(aws_profile, aws_region)
        except Exception as e:
            job.status = UploadStatus.FAILED
            for file_state in job.files:
                file_state.status = UploadStatus.FAILED
                file_state.error_message = f"Failed to create S3 client: {e}"
            return job

        # Analyze each file
        for file_state in job.files:
            file_state.status = UploadStatus.ANALYZING
            try:
                # Extract timestamp from MCAP
                start_time = mcap_service.extract_start_time(file_state.local_path)
                file_state.start_time = start_time

                # Generate S3 path
                s3_path = mcap_service.generate_s3_path(start_time, file_state.filename)
                file_state.s3_path = s3_path

                # Check for duplicates
                file_state.is_duplicate = s3_service.check_file_exists(
                    s3_client, s3_bucket, s3_path
                )

                file_state.status = UploadStatus.READY

            except Exception as e:
                file_state.status = UploadStatus.FAILED
                file_state.error_message = str(e)

        # Update job status
        job.resolve_analysis_status()

        return job

    def _analyze_single_file(
        self,
        file_state: FileUploadState,
        s3_client: Any,
        s3_bucket: str,
        use_cache: bool = True,
        job_id: str = "",
        progress_callback: Callable[["UploadJob", FileUploadState], None] | None = None,
        job: "UploadJob | None" = None,
    ) -> FileUploadState:
        """Analyze a single file - extract timestamp and check for duplicates.

        Args:
            file_state: The file state to analyze
            s3_client: S3 client for duplicate checking
            s3_bucket: S3 bucket name
            use_cache: Whether to use the cache for duplicate checking
            job_id: The parent job ID (for logging)
            progress_callback: Optional callback fired when file starts analyzing
            job: The parent UploadJob (needed for callback)

        Returns:
            The updated FileUploadState
        """
        log = get_log_service()
        file_state.status = UploadStatus.ANALYZING
        if progress_callback and job:
            progress_callback(job, file_state)
        try:
            # Extract timestamp from MCAP
            start_time = mcap_service.extract_start_time(file_state.local_path)
            file_state.start_time = start_time

            # Check if timestamp is valid (after 1980)
            naive_start = mcap_service.to_naive_utc(start_time)
            file_state.is_valid = naive_start >= EPOCH_CUTOFF.replace(tzinfo=None)

            # Generate S3 path
            s3_path = mcap_service.generate_s3_path(start_time, file_state.filename)
            file_state.s3_path = s3_path

            # Check for duplicates - try cache first
            cache_result: bool | None = None
            if use_cache:
                cache = get_cache_service()
                cache_result = cache.check_exists_cached(s3_bucket, s3_path)

            if cache_result is not None:
                # Cache hit
                file_state.is_duplicate = cache_result
            else:
                # Cache miss - check S3 directly
                file_state.is_duplicate = s3_service.check_file_exists(
                    s3_client, s3_bucket, s3_path
                )
                # Update cache with result
                if use_cache:
                    cache = get_cache_service()
                    cache.update_cache(
                        s3_bucket,
                        s3_path,
                        file_state.is_duplicate,
                        file_state.filename,
                        file_state.file_size,
                    )

            file_state.status = UploadStatus.READY

            log.info(
                "analysis",
                "file_analysis_completed",
                f"Analyzed {file_state.filename}",
                {
                    "job_id": job_id,
                    "filename": file_state.filename,
                    "file_size": file_state.file_size,
                    "s3_path": file_state.s3_path,
                    "is_duplicate": file_state.is_duplicate,
                    "is_valid": file_state.is_valid,
                },
            )

        except Exception as e:
            file_state.status = UploadStatus.FAILED
            file_state.error_message = str(e)

            log.error(
                "analysis",
                "file_analysis_failed",
                f"Failed to analyze {file_state.filename}: {e}",
                {"job_id": job_id, "filename": file_state.filename, "error": str(e)},
            )

        return file_state

    def analyze_job_async(
        self,
        job_id: str,
        aws_profile: str,
        aws_region: str,
        s3_bucket: str,
        progress_callback: Callable[["UploadJob", FileUploadState], None] | None = None,
        use_cache: bool = True,
    ) -> UploadJob | None:
        """Analyze files in a job asynchronously with parallel processing.

        Args:
            job_id: The job ID to analyze
            aws_profile: AWS profile to use
            aws_region: AWS region
            s3_bucket: S3 bucket to check for duplicates
            progress_callback: Optional callback called after each file completes
            use_cache: Whether to use cache for duplicate checking

        Returns:
            The updated UploadJob or None if not found
        """
        log = get_log_service()
        job = self.get_job(job_id)
        if not job:
            return None

        job.status = UploadStatus.ANALYZING

        log.info(
            "analysis",
            "analysis_started",
            f"Starting analysis of {len(job.files)} files",
            {"job_id": job_id, "total_files": len(job.files)},
        )

        # Keep files as PENDING; workers will mark ANALYZING when they start.
        # Send initial callbacks so frontend knows the job started and can show queue.
        if progress_callback:
            for file_state in job.files:
                progress_callback(job, file_state)

        # Create S3 client for duplicate checking
        try:
            s3_client = s3_service.create_s3_client(aws_profile, aws_region)
        except Exception as e:
            job.status = UploadStatus.FAILED
            for file_state in job.files:
                file_state.status = UploadStatus.FAILED
                file_state.error_message = f"Failed to create S3 client: {e}"
                if progress_callback:
                    progress_callback(job, file_state)
            return job

        # Analyze files in parallel
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {}
            for file_state in job.files:
                future = executor.submit(
                    self._analyze_single_file,
                    file_state,
                    s3_client,
                    s3_bucket,
                    use_cache,
                    job_id,
                    progress_callback,
                    job,
                )
                futures[future] = file_state

            # Process results as they complete
            for future in as_completed(futures):
                file_state = futures[future]
                try:
                    # Result is already updated in-place, but get it to handle exceptions
                    future.result()
                except Exception as e:
                    with job.lock:
                        file_state.status = UploadStatus.FAILED
                        file_state.error_message = str(e)

                # Call progress callback
                if progress_callback:
                    progress_callback(job, file_state)

        # Update job status
        with job.lock:
            job.resolve_analysis_status()

        ready_count = sum(1 for f in job.files if f.status == UploadStatus.READY)
        failed_count = sum(1 for f in job.files if f.status == UploadStatus.FAILED)
        duplicate_count = sum(1 for f in job.files if f.is_duplicate)

        log.info(
            "analysis",
            "analysis_completed",
            f"Analysis complete: {ready_count} ready, {failed_count} failed, "
            f"{duplicate_count} duplicates",
            {
                "job_id": job_id,
                "ready": ready_count,
                "failed": failed_count,
                "duplicates": duplicate_count,
            },
        )

        return job

    def start_upload(
        self,
        job_id: str,
        aws_profile: str,
        aws_region: str,
        s3_bucket: str,
        skip_duplicates: bool = True,
        progress_callback: Callable[["UploadJob"], None] | None = None,
    ) -> None:
        """Start uploading files in a job.

        Args:
            job_id: The job ID to upload
            aws_profile: AWS profile to use
            aws_region: AWS region
            s3_bucket: S3 bucket to upload to
            skip_duplicates: Whether to skip files that already exist
            progress_callback: Optional callback for progress updates
        """
        job = self.get_job(job_id)
        if not job:
            return

        job.status = UploadStatus.UPLOADING
        job.started_at = datetime.now(UTC)

        # Create S3 client
        try:
            s3_client = s3_service.create_s3_client(aws_profile, aws_region)
        except Exception as e:
            job.status = UploadStatus.FAILED
            for file_state in job.files:
                if file_state.status == UploadStatus.READY:
                    file_state.status = UploadStatus.FAILED
                    file_state.error_message = f"Failed to create S3 client: {e}"
            return

        log = get_log_service()

        # Filter files to upload
        files_to_upload = []
        for file_state in job.files:
            if file_state.status != UploadStatus.READY:
                continue

            if skip_duplicates and file_state.is_duplicate:
                file_state.status = UploadStatus.SKIPPED
                file_state.bytes_uploaded = file_state.file_size
                log.info(
                    "upload",
                    "file_upload_skipped",
                    f"Skipped duplicate: {file_state.filename}",
                    {"job_id": job_id, "filename": file_state.filename, "reason": "duplicate"},
                )
                continue

            # Skip files with invalid timestamps
            if not file_state.is_valid:
                file_state.status = UploadStatus.SKIPPED
                file_state.error_message = "Invalid timestamp (pre-1980)"
                log.warning(
                    "upload",
                    "file_upload_skipped",
                    f"Skipped invalid timestamp: {file_state.filename}",
                    {
                        "job_id": job_id,
                        "filename": file_state.filename,
                        "reason": "invalid_timestamp",
                    },
                )
                continue

            files_to_upload.append(file_state)

        # Upload files in parallel
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {}
            for file_state in files_to_upload:
                if job.cancelled:
                    break

                def make_upload_task(
                    fs: FileUploadState,
                ) -> Callable[[], Any]:
                    def upload_task() -> Any:
                        # Mark UPLOADING inside the worker so files stay READY until picked up
                        with job.lock:
                            fs.status = UploadStatus.UPLOADING
                            fs.upload_started_at = datetime.now(UTC)
                        log.info(
                            "upload",
                            "file_upload_started",
                            f"Uploading {fs.filename}",
                            {
                                "job_id": job_id,
                                "filename": fs.filename,
                                "file_size": fs.file_size,
                                "s3_path": fs.s3_path,
                            },
                        )
                        if progress_callback:
                            progress_callback(job)

                        def byte_callback(uploaded: int, total: int) -> None:
                            with job.lock:
                                fs.bytes_uploaded = uploaded
                            if progress_callback:
                                progress_callback(job)

                        return s3_service.upload_file_with_progress(
                            s3_client,
                            fs.local_path,
                            s3_bucket,
                            fs.s3_path,
                            byte_callback,
                        )

                    return upload_task

                future = executor.submit(make_upload_task(file_state))
                futures[future] = file_state

            # Process results as they complete
            for future in as_completed(futures):
                if job.cancelled:
                    break

                file_state = futures[future]
                try:
                    result = future.result()
                    file_state.upload_completed_at = datetime.now(UTC)
                    if result["success"]:
                        file_state.status = UploadStatus.COMPLETED
                        file_state.bytes_uploaded = file_state.file_size
                        log.info(
                            "upload",
                            "file_upload_completed",
                            f"Uploaded {file_state.filename}",
                            {
                                "job_id": job_id,
                                "filename": file_state.filename,
                                "file_size": file_state.file_size,
                                "upload_duration_seconds": file_state.upload_duration_seconds,
                                "s3_path": file_state.s3_path,
                            },
                        )
                        # Update cache to mark file as existing
                        try:
                            cache = get_cache_service()
                            cache.update_cache(
                                s3_bucket,
                                file_state.s3_path,
                                exists=True,
                                filename=file_state.filename,
                                file_size=file_state.file_size,
                            )
                        except Exception:
                            logger.debug("Cache update failed after upload", exc_info=True)
                    else:
                        file_state.status = UploadStatus.FAILED
                        file_state.error_message = result.get("error", "Unknown error")
                        log.error(
                            "upload",
                            "file_upload_failed",
                            f"Failed to upload {file_state.filename}: {file_state.error_message}",
                            {
                                "job_id": job_id,
                                "filename": file_state.filename,
                                "error": file_state.error_message,
                            },
                        )
                except Exception as e:
                    file_state.upload_completed_at = datetime.now(UTC)
                    file_state.status = UploadStatus.FAILED
                    file_state.error_message = str(e)
                    log.error(
                        "upload",
                        "file_upload_failed",
                        f"Failed to upload {file_state.filename}: {e}",
                        {"job_id": job_id, "filename": file_state.filename, "error": str(e)},
                    )

                if progress_callback:
                    progress_callback(job)

        # Update final job status
        job.completed_at = datetime.now(UTC)
        if job.cancelled:
            job.status = UploadStatus.CANCELLED
        elif all(f.status in (UploadStatus.COMPLETED, UploadStatus.SKIPPED) for f in job.files):
            job.status = UploadStatus.COMPLETED
        elif any(f.status == UploadStatus.COMPLETED for f in job.files):
            job.status = UploadStatus.COMPLETED  # Partial success
        else:
            job.status = UploadStatus.FAILED

        # Clean up temp directory when upload completes
        self.cleanup_temp_dir(job_id)

        uploaded_count = sum(1 for f in job.files if f.status == UploadStatus.COMPLETED)
        skipped_count = sum(1 for f in job.files if f.status == UploadStatus.SKIPPED)
        failed_count = sum(1 for f in job.files if f.status == UploadStatus.FAILED)

        # Build per-file summary for logging
        file_summary = [
            {
                "filename": f.filename,
                "s3_path": f.s3_path,
                "status": f.status.value,
                "file_size": f.file_size,
                "duration_seconds": f.upload_duration_seconds,
            }
            for f in job.files
        ]

        log.info(
            "upload",
            "upload_job_completed",
            f"Upload job completed: {uploaded_count} uploaded, "
            f"{skipped_count} skipped, {failed_count} failed",
            {
                "job_id": job_id,
                "status": job.status.value,
                "uploaded": uploaded_count,
                "skipped": skipped_count,
                "failed": failed_count,
                "total_bytes_uploaded": job.successfully_uploaded_bytes,
                "duration_seconds": job.total_upload_duration_seconds,
                "avg_speed_mbps": job.average_upload_speed_mbps,
                "files": file_summary,
            },
        )

        # Save per-job JSONL summary
        try:
            completed_at = job.completed_at or datetime.now(UTC)
            log.save_job_jsonl(job_id, {
                "timestamp": completed_at.isoformat(),
                "event": "upload_job_completed",
                "job_id": job_id,
                "status": job.status.value,
                "uploaded": uploaded_count,
                "skipped": skipped_count,
                "failed": failed_count,
                "total_bytes_uploaded": job.successfully_uploaded_bytes,
                "duration_seconds": job.total_upload_duration_seconds,
                "avg_speed_mbps": job.average_upload_speed_mbps,
                "files": file_summary,
            }, completed_at)
        except Exception:
            logger.warning("Failed to save job JSONL summary", exc_info=True)

        # Save upload summary CSV
        try:
            log.save_job_csv(job_id, job, completed_at)
        except Exception:
            logger.warning("Failed to save job CSV summary", exc_info=True)

        # Auto-sync logs to S3 after job completion
        try:
            log.sync_logs_to_s3(s3_client, s3_bucket)
        except Exception:
            logger.debug("Log sync to S3 failed", exc_info=True)

        if progress_callback:
            progress_callback(job)

    def cancel_job(self, job_id: str) -> bool:
        """Cancel an upload job.

        Args:
            job_id: The job ID to cancel

        Returns:
            True if job was found and cancelled
        """
        job = self.get_job(job_id)
        if not job:
            return False

        job.cancelled = True
        for file_state in job.files:
            if file_state.status in (UploadStatus.PENDING, UploadStatus.READY):
                file_state.status = UploadStatus.CANCELLED

        # Clean up temp directory when job is cancelled
        self.cleanup_temp_dir(job_id)

        log = get_log_service()
        log.warning(
            "upload",
            "upload_job_cancelled",
            f"Upload job {job_id} cancelled",
            {"job_id": job_id},
        )

        return True

    def cleanup_temp_dir(self, job_id: str) -> bool:
        """Clean up temp directory for a job.

        Args:
            job_id: The job ID to clean up

        Returns:
            True if temp directory was cleaned up
        """
        job = self.get_job(job_id)
        if not job or not job.temp_dir:
            return False

        temp_path = Path(job.temp_dir)
        if temp_path.exists() and temp_path.is_dir():
            try:
                shutil.rmtree(temp_path)
                job.temp_dir = None
                return True
            except Exception:
                logger.warning("Failed to clean up temp dir: %s", temp_path, exc_info=True)
        return False

    def pre_filter_files(
        self,
        file_paths: list[str],
        s3_bucket: str,
        aws_profile: str = "default",
        aws_region: str = "us-west-2",
    ) -> tuple[list[str], dict[str, Any]]:
        """Pre-filter files using cache and filename timestamp extraction.

        This is a fast pre-filtering step that avoids expensive MCAP parsing
        by extracting timestamps from filenames and checking the cache.
        On cache miss, falls back to S3 HEAD checks.

        Args:
            file_paths: List of file paths to filter
            s3_bucket: S3 bucket name for cache lookup
            aws_profile: AWS profile for S3 fallback checks
            aws_region: AWS region for S3 fallback checks

        Returns:
            Tuple of (files_to_analyze, stats_dict)
            stats_dict includes 'file_statuses' with per-file upload status
        """
        cache = get_cache_service()
        files_to_analyze: list[str] = []
        file_statuses: list[dict[str, Any]] = []
        # Track cache misses that have valid S3 paths for batch S3 check
        cache_miss_indices: list[int] = []
        cache_miss_s3_paths: list[str] = []

        stats: dict[str, Any] = {
            "total": len(file_paths),
            "cache_hits": 0,
            "cache_skipped": 0,
            "s3_hits": 0,
            "no_timestamp": 0,
            "to_analyze": 0,
        }

        for file_path in file_paths:
            path = Path(file_path)
            if not path.exists():
                continue

            stat = path.stat()
            file_status: dict[str, Any] = {
                "path": file_path,
                "filename": path.name,
                "size": stat.st_size,
                "mtime": stat.st_mtime,
                "already_uploaded": False,
            }

            # First: check cache by filename+size (works regardless of timestamp source)
            filename_result = cache.check_exists_by_filename(
                s3_bucket, path.name, stat.st_size
            )
            if filename_result is True:
                stats["cache_hits"] += 1
                stats["cache_skipped"] += 1
                file_status["already_uploaded"] = True
                file_statuses.append(file_status)
                continue

            # Try to extract timestamp from filename (fast, no file I/O)
            timestamp = mcap_service._extract_timestamp_from_filename(path.name)

            if timestamp is None:
                # Can't extract timestamp from filename, need full analysis
                stats["no_timestamp"] += 1
                files_to_analyze.append(file_path)
                file_statuses.append(file_status)
                continue

            # Generate S3 path from filename timestamp
            s3_path = mcap_service.generate_s3_path(timestamp, path.name)
            file_status["s3_path"] = s3_path

            # Check cache by S3 path
            cache_result = cache.check_exists_cached(s3_bucket, s3_path)

            if cache_result is True:
                # File already exists in S3, skip
                stats["cache_hits"] += 1
                stats["cache_skipped"] += 1
                file_status["already_uploaded"] = True
            elif cache_result is False:
                # Cache says it doesn't exist
                stats["cache_hits"] += 1
                files_to_analyze.append(file_path)
            else:
                # Cache miss (None) — need S3 check
                cache_miss_indices.append(len(file_statuses))
                cache_miss_s3_paths.append(s3_path)

            file_statuses.append(file_status)

        # Batch S3 HEAD checks for cache misses
        if cache_miss_s3_paths:
            try:
                s3_client = s3_service.create_s3_client(aws_profile, aws_region)

                def check_s3(s3_path: str) -> bool:
                    return s3_service.check_file_exists(s3_client, s3_bucket, s3_path)

                with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
                    results = list(executor.map(check_s3, cache_miss_s3_paths))

                for idx, s3_path, exists in zip(
                    cache_miss_indices, cache_miss_s3_paths, results, strict=True
                ):
                    # Update cache with result
                    fs = file_statuses[idx]
                    cache.update_cache(
                        s3_bucket, s3_path, exists, fs["filename"], fs["size"]
                    )
                    if exists:
                        stats["s3_hits"] += 1
                        fs["already_uploaded"] = True
                    else:
                        files_to_analyze.append(fs["path"])
            except Exception:
                # S3 check failed — fall back to full analysis for cache misses
                for idx in cache_miss_indices:
                    files_to_analyze.append(file_statuses[idx]["path"])

        stats["to_analyze"] = len(files_to_analyze)
        stats["file_statuses"] = file_statuses
        return files_to_analyze, stats

    def get_active_jobs(self) -> list[UploadJob]:
        """Get all currently active (non-terminal) jobs."""
        active_statuses = {
            UploadStatus.PENDING,
            UploadStatus.ANALYZING,
            UploadStatus.READY,
            UploadStatus.UPLOADING,
        }
        with self._lock:
            return [j for j in self.jobs.values() if j.status in active_statuses]

    def cleanup_old_jobs(self, max_age_seconds: int = 3600) -> int:
        """Remove completed jobs older than max_age_seconds.

        Args:
            max_age_seconds: Maximum age in seconds for completed jobs

        Returns:
            Number of jobs removed
        """
        now = datetime.now(UTC)
        removed = 0

        with self._lock:
            to_remove = []
            for job_id, job in self.jobs.items():
                if job.completed_at:
                    age = (now - job.completed_at).total_seconds()
                    if age > max_age_seconds:
                        to_remove.append(job_id)

            for job_id in to_remove:
                del self.jobs[job_id]
                removed += 1

        return removed


# Global upload manager instance
_upload_manager: UploadManager | None = None


def get_upload_manager() -> UploadManager:
    """Get the global upload manager instance."""
    global _upload_manager
    if _upload_manager is None:
        _upload_manager = UploadManager()
    return _upload_manager
