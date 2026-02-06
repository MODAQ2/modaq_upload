"""Upload manager for orchestrating file uploads to S3."""

import shutil
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

from app.services import mcap_service, s3_service
from app.services.cache_service import get_cache_service

# Timestamps before this date are considered invalid (1970/epoch issues)
EPOCH_CUTOFF = datetime(1980, 1, 1)


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
            "file_size_formatted": mcap_service.format_file_size(self.file_size),
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
    created_at: datetime = field(default_factory=datetime.now)
    started_at: datetime | None = None
    completed_at: datetime | None = None
    cancelled: bool = False
    auto_upload: bool = False  # Auto-start upload when analysis completes
    temp_dir: str | None = None  # Temp directory for cleanup
    pre_filter_stats: dict[str, Any] = field(default_factory=dict)  # Pre-filter statistics
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

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

        elapsed = (datetime.now() - self.started_at).total_seconds()
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
            "total_bytes_formatted": mcap_service.format_file_size(self.total_bytes),
            "uploaded_bytes": self.uploaded_bytes,
            "uploaded_bytes_formatted": mcap_service.format_file_size(self.uploaded_bytes),
            "successfully_uploaded_bytes": self.successfully_uploaded_bytes,
            "successfully_uploaded_bytes_formatted": mcap_service.format_file_size(
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
        if all(f.status == UploadStatus.READY for f in job.files):
            job.status = UploadStatus.READY
        elif any(f.status == UploadStatus.READY for f in job.files):
            job.status = UploadStatus.READY
        else:
            job.status = UploadStatus.FAILED

        return job

    def _analyze_single_file(
        self,
        file_state: FileUploadState,
        s3_client: Any,
        s3_bucket: str,
        use_cache: bool = True,
    ) -> FileUploadState:
        """Analyze a single file - extract timestamp and check for duplicates.

        Args:
            file_state: The file state to analyze
            s3_client: S3 client for duplicate checking
            s3_bucket: S3 bucket name
            use_cache: Whether to use the cache for duplicate checking

        Returns:
            The updated FileUploadState
        """
        file_state.status = UploadStatus.ANALYZING
        try:
            # Extract timestamp from MCAP
            start_time = mcap_service.extract_start_time(file_state.local_path)
            file_state.start_time = start_time

            # Check if timestamp is valid (after 1980)
            check_time = start_time.replace(tzinfo=None) if start_time.tzinfo else start_time
            file_state.is_valid = check_time >= EPOCH_CUTOFF

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

        except Exception as e:
            file_state.status = UploadStatus.FAILED
            file_state.error_message = str(e)

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
        job = self.get_job(job_id)
        if not job:
            return None

        job.status = UploadStatus.ANALYZING

        # Mark all files as analyzing
        for file_state in job.files:
            file_state.status = UploadStatus.ANALYZING

        # Send initial progress
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
                )
                futures[future] = file_state

            # Process results as they complete
            for future in as_completed(futures):
                file_state = futures[future]
                try:
                    # Result is already updated in-place, but get it to handle exceptions
                    future.result()
                except Exception as e:
                    with job._lock:
                        file_state.status = UploadStatus.FAILED
                        file_state.error_message = str(e)

                # Call progress callback
                if progress_callback:
                    progress_callback(job, file_state)

        # Update job status
        with job._lock:
            if all(f.status == UploadStatus.READY for f in job.files):
                job.status = UploadStatus.READY
            elif any(f.status == UploadStatus.READY for f in job.files):
                job.status = UploadStatus.READY
            else:
                job.status = UploadStatus.FAILED

        return job

    def start_upload(
        self,
        job_id: str,
        aws_profile: str,
        aws_region: str,
        s3_bucket: str,
        skip_duplicates: bool = True,
        progress_callback: Any | None = None,
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
        job.started_at = datetime.now()

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

        # Filter files to upload
        files_to_upload = []
        for file_state in job.files:
            if file_state.status != UploadStatus.READY:
                continue

            if skip_duplicates and file_state.is_duplicate:
                file_state.status = UploadStatus.SKIPPED
                file_state.bytes_uploaded = file_state.file_size
                continue

            # Skip files with invalid timestamps
            if not file_state.is_valid:
                file_state.status = UploadStatus.SKIPPED
                file_state.error_message = "Invalid timestamp (pre-1980)"
                continue

            files_to_upload.append(file_state)

        # Upload files in parallel
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {}
            for file_state in files_to_upload:
                if job.cancelled:
                    break

                def make_callback(
                    fs: FileUploadState,
                ) -> Any:
                    def callback(uploaded: int, total: int) -> None:
                        with job._lock:
                            fs.bytes_uploaded = uploaded
                        if progress_callback:
                            progress_callback(job)

                    return callback

                file_state.status = UploadStatus.UPLOADING
                file_state.upload_started_at = datetime.now()
                future = executor.submit(
                    s3_service.upload_file_with_progress,
                    s3_client,
                    file_state.local_path,
                    s3_bucket,
                    file_state.s3_path,
                    make_callback(file_state),
                )
                futures[future] = file_state

            # Process results as they complete
            for future in as_completed(futures):
                if job.cancelled:
                    break

                file_state = futures[future]
                try:
                    result = future.result()
                    file_state.upload_completed_at = datetime.now()
                    if result["success"]:
                        file_state.status = UploadStatus.COMPLETED
                        file_state.bytes_uploaded = file_state.file_size
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
                            pass  # Cache update failure shouldn't fail the upload
                    else:
                        file_state.status = UploadStatus.FAILED
                        file_state.error_message = result.get("error", "Unknown error")
                except Exception as e:
                    file_state.upload_completed_at = datetime.now()
                    file_state.status = UploadStatus.FAILED
                    file_state.error_message = str(e)

                if progress_callback:
                    progress_callback(job)

        # Update final job status
        job.completed_at = datetime.now()
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
                pass
        return False

    def pre_filter_files(
        self,
        file_paths: list[str],
        s3_bucket: str,
    ) -> tuple[list[str], dict[str, Any]]:
        """Pre-filter files using cache and filename timestamp extraction.

        This is a fast pre-filtering step that avoids expensive MCAP parsing
        by extracting timestamps from filenames and checking the cache.

        Args:
            file_paths: List of file paths to filter
            s3_bucket: S3 bucket name for cache lookup

        Returns:
            Tuple of (files_to_analyze, stats_dict)
            stats_dict includes 'file_statuses' with per-file upload status
        """
        cache = get_cache_service()
        files_to_analyze: list[str] = []
        file_statuses: list[dict[str, Any]] = []

        stats: dict[str, Any] = {
            "total": len(file_paths),
            "cache_hits": 0,
            "cache_skipped": 0,
            "no_timestamp": 0,
            "to_analyze": 0,
        }

        for file_path in file_paths:
            path = Path(file_path)
            if not path.exists():
                continue

            file_status: dict[str, Any] = {
                "path": file_path,
                "filename": path.name,
                "size": path.stat().st_size,
                "already_uploaded": False,
            }

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

            # Check cache
            cache_result = cache.check_exists_cached(s3_bucket, s3_path)

            if cache_result is True:
                # File already exists in S3, skip
                stats["cache_hits"] += 1
                stats["cache_skipped"] += 1
                file_status["already_uploaded"] = True
            else:
                # Not in cache or doesn't exist, need analysis
                if cache_result is not None:
                    stats["cache_hits"] += 1
                files_to_analyze.append(file_path)

            file_statuses.append(file_status)

        stats["to_analyze"] = len(files_to_analyze)
        stats["file_statuses"] = file_statuses
        return files_to_analyze, stats

    def cleanup_old_jobs(self, max_age_seconds: int = 3600) -> int:
        """Remove completed jobs older than max_age_seconds.

        Args:
            max_age_seconds: Maximum age in seconds for completed jobs

        Returns:
            Number of jobs removed
        """
        now = datetime.now()
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
