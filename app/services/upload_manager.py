"""Upload manager for orchestrating file uploads to S3."""

import logging
import os
import shutil
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
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


def _extract_start_time_worker(local_path: str) -> datetime | str:
    """Worker function for ProcessPoolExecutor — must be top-level for pickling.

    Returns:
        datetime on success, or error message string on failure.
    """
    try:
        return mcap_service.extract_start_time(local_path)
    except Exception as e:
        return str(e)


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

    def to_progress_dict(self) -> dict[str, Any]:
        """Lightweight dict for SSE progress events.

        Includes only job-level stats and currently active files (uploading/analyzing),
        dropping the full 20K-file array that to_dict() includes.
        """
        active_files = [
            f.to_dict()
            for f in self.files
            if f.status in (UploadStatus.UPLOADING, UploadStatus.ANALYZING)
        ]
        return {
            "job_id": self.job_id,
            "status": self.status.value,
            "progress_percent": self.progress_percent,
            "files_completed": self.files_completed,
            "total_files": len(self.files),
            "uploaded_bytes_formatted": format_file_size(self.uploaded_bytes),
            "total_bytes_formatted": format_file_size(self.total_bytes),
            "eta_seconds": self.eta_seconds,
            "files_failed": self.files_failed,
            "files_skipped": sum(1 for f in self.files if f.status == UploadStatus.SKIPPED),
            "files_uploaded": sum(1 for f in self.files if f.status == UploadStatus.COMPLETED),
            "cancelled": self.cancelled,
            "files": active_files,
        }

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


@dataclass
class ScannedFolder:
    """Results for a single scanned subfolder."""

    folder_path: str
    relative_path: str
    files: list[dict[str, Any]]
    total_files: int = 0
    already_uploaded: int = 0
    all_uploaded: bool = False
    error: str | None = None


@dataclass
class ScanJob:
    """Tracks an async folder scan job."""

    job_id: str
    root_folder: str
    status: str = "scanning"  # scanning | completed | failed | cancelled
    cancelled: bool = False
    folders_scanned: int = 0
    folders_total: int = 0
    total_files_found: int = 0
    total_already_uploaded: int = 0
    total_size: int = 0
    scanned_folders: list[dict[str, Any]] = field(default_factory=list)
    excluded_subfolders: list[str] = field(default_factory=list)
    excluded_files: list[str] = field(default_factory=list)
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


class UploadManager:
    """Manages upload jobs and their execution."""

    def __init__(self, max_workers: int = 4) -> None:
        self.jobs: dict[str, UploadJob] = {}
        self.scan_jobs: dict[str, ScanJob] = {}
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

    def _check_duplicate(
        self,
        file_state: FileUploadState,
        s3_client: Any,
        s3_bucket: str,
        use_cache: bool = True,
    ) -> None:
        """Check if a file already exists in S3 (I/O-bound, safe for threads)."""
        s3_path = file_state.s3_path
        if not s3_path:
            return

        cache_result: bool | None = None
        if use_cache:
            cache = get_cache_service()
            cache_result = cache.check_exists_cached(s3_bucket, s3_path)

        if cache_result is not None:
            file_state.is_duplicate = cache_result
        else:
            file_state.is_duplicate = s3_service.check_file_exists(s3_client, s3_bucket, s3_path)
            if use_cache:
                cache = get_cache_service()
                cache.update_cache(
                    s3_bucket,
                    s3_path,
                    file_state.is_duplicate,
                    file_state.filename,
                    file_state.file_size,
                )

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

        # Phase 1: MCAP parsing (CPU-bound) — use ProcessPoolExecutor for true
        # parallelism across cores, bypassing the GIL.
        cpu_workers = max(1, (os.cpu_count() or 4) - 1)
        for file_state in job.files:
            file_state.status = UploadStatus.ANALYZING

        with ProcessPoolExecutor(max_workers=cpu_workers) as proc_executor:
            parse_futures = {
                proc_executor.submit(_extract_start_time_worker, file_state.local_path): file_state
                for file_state in job.files
            }
            for future in as_completed(parse_futures):
                file_state = parse_futures[future]
                result = future.result()
                if isinstance(result, str):
                    # Error message returned from worker
                    file_state.status = UploadStatus.FAILED
                    file_state.error_message = result
                    log.error(
                        "analysis",
                        "file_analysis_failed",
                        f"Failed to analyze {file_state.filename}: {result}",
                        {"job_id": job_id, "filename": file_state.filename, "error": result},
                    )
                else:
                    file_state.start_time = result
                    naive_start = mcap_service.to_naive_utc(result)
                    file_state.is_valid = naive_start >= EPOCH_CUTOFF.replace(tzinfo=None)
                    file_state.s3_path = mcap_service.generate_s3_path(result, file_state.filename)
                if progress_callback:
                    progress_callback(job, file_state)

        # Phase 2: S3 duplicate checks (I/O-bound) — threads are fine here.
        parsed_files = [f for f in job.files if f.status != UploadStatus.FAILED]
        with ThreadPoolExecutor(max_workers=self.max_workers) as io_executor:
            dup_futures: dict[Any, FileUploadState] = {}
            for file_state in parsed_files:
                fut = io_executor.submit(
                    self._check_duplicate,
                    file_state,
                    s3_client,
                    s3_bucket,
                    use_cache,
                )
                dup_futures[fut] = file_state

            for fut in as_completed(dup_futures):
                file_state = dup_futures[fut]
                try:
                    fut.result()
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
                    with job.lock:
                        file_state.status = UploadStatus.FAILED
                        file_state.error_message = str(e)

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

        # Send terminal event IMMEDIATELY so the frontend unblocks.
        # Heavy I/O (logging, CSV, S3 sync) follows below.
        if progress_callback:
            progress_callback(job)

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
            log.save_job_jsonl(
                job_id,
                {
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
                },
                completed_at,
            )
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

    def analyze_and_upload_pipeline(
        self,
        job_id: str,
        aws_profile: str,
        aws_region: str,
        s3_bucket: str,
        skip_duplicates: bool = True,
        analysis_callback: Callable[["UploadJob", FileUploadState], None] | None = None,
        upload_callback: Callable[["UploadJob"], None] | None = None,
        use_cache: bool = True,
    ) -> None:
        """Analyze each file and upload it immediately — pipeline approach.

        Instead of analyzing all files first and then uploading, this processes
        files through a pipeline: MCAP parsing runs in a ProcessPoolExecutor,
        and as each parse completes the file is immediately checked for duplicates
        and submitted to a ThreadPoolExecutor for upload.

        Args:
            job_id: The job ID to process
            aws_profile: AWS profile to use
            aws_region: AWS region
            s3_bucket: S3 bucket to upload to
            skip_duplicates: Whether to skip files that already exist
            analysis_callback: Called after each file is analyzed
            upload_callback: Called for upload progress updates
            use_cache: Whether to use cache for duplicate checking
        """
        log = get_log_service()
        job = self.get_job(job_id)
        if not job:
            return

        job.status = UploadStatus.UPLOADING
        job.started_at = datetime.now(UTC)

        log.info(
            "upload",
            "pipeline_started",
            f"Starting analyze-and-upload pipeline for {len(job.files)} files",
            {"job_id": job_id, "total_files": len(job.files)},
        )

        # Create S3 client
        try:
            s3_client = s3_service.create_s3_client(aws_profile, aws_region)
        except Exception as e:
            job.status = UploadStatus.FAILED
            for file_state in job.files:
                file_state.status = UploadStatus.FAILED
                file_state.error_message = f"Failed to create S3 client: {e}"
                if analysis_callback:
                    analysis_callback(job, file_state)
            if upload_callback:
                upload_callback(job)
            return

        cpu_workers = max(1, (os.cpu_count() or 4) - 1)
        upload_executor = ThreadPoolExecutor(max_workers=self.max_workers)

        # Set all files to ANALYZING
        for fs in job.files:
            fs.status = UploadStatus.ANALYZING

        try:
            # Submit all files for MCAP parsing (CPU-bound, true parallelism)
            with ProcessPoolExecutor(max_workers=cpu_workers) as proc_executor:
                parse_futures = {
                    proc_executor.submit(_extract_start_time_worker, fs.local_path): fs
                    for fs in job.files
                }

                for future in as_completed(parse_futures):
                    if job.cancelled:
                        break

                    fs = parse_futures[future]
                    result = future.result()

                    if isinstance(result, str):
                        # Parse failed
                        fs.status = UploadStatus.FAILED
                        fs.error_message = result
                        log.error(
                            "analysis",
                            "file_analysis_failed",
                            f"Failed to analyze {fs.filename}: {result}",
                            {"job_id": job_id, "filename": fs.filename, "error": result},
                        )
                        if analysis_callback:
                            analysis_callback(job, fs)
                        continue

                    # Parse succeeded — set timestamp and generate S3 path
                    fs.start_time = result
                    naive_start = mcap_service.to_naive_utc(result)
                    fs.is_valid = naive_start >= EPOCH_CUTOFF.replace(tzinfo=None)
                    fs.s3_path = mcap_service.generate_s3_path(result, fs.filename)

                    # Check duplicate (I/O but fast — cache lookup or S3 HEAD)
                    self._check_duplicate(fs, s3_client, s3_bucket, use_cache)
                    fs.status = UploadStatus.READY

                    log.info(
                        "analysis",
                        "file_analysis_completed",
                        f"Analyzed {fs.filename}",
                        {
                            "job_id": job_id,
                            "filename": fs.filename,
                            "file_size": fs.file_size,
                            "s3_path": fs.s3_path,
                            "is_duplicate": fs.is_duplicate,
                            "is_valid": fs.is_valid,
                        },
                    )

                    # Notify frontend of analysis result
                    if analysis_callback:
                        analysis_callback(job, fs)

                    # Decide: skip or upload?
                    if not fs.is_valid:
                        fs.status = UploadStatus.SKIPPED
                        fs.error_message = "Invalid timestamp (pre-1980)"
                        log.warning(
                            "upload",
                            "file_upload_skipped",
                            f"Skipped invalid timestamp: {fs.filename}",
                            {
                                "job_id": job_id,
                                "filename": fs.filename,
                                "reason": "invalid_timestamp",
                            },
                        )
                        if upload_callback:
                            upload_callback(job)
                        continue

                    if skip_duplicates and fs.is_duplicate:
                        fs.status = UploadStatus.SKIPPED
                        fs.bytes_uploaded = fs.file_size
                        log.info(
                            "upload",
                            "file_upload_skipped",
                            f"Skipped duplicate: {fs.filename}",
                            {
                                "job_id": job_id,
                                "filename": fs.filename,
                                "reason": "duplicate",
                            },
                        )
                        if upload_callback:
                            upload_callback(job)
                        continue

                    # Submit for upload immediately
                    def make_upload_task(
                        file_state: FileUploadState,
                    ) -> Callable[[], Any]:
                        def upload_task() -> Any:
                            if job.cancelled:
                                with job.lock:
                                    file_state.status = UploadStatus.CANCELLED
                                return None

                            try:
                                with job.lock:
                                    file_state.status = UploadStatus.UPLOADING
                                    file_state.upload_started_at = datetime.now(UTC)
                                log.info(
                                    "upload",
                                    "file_upload_started",
                                    f"Uploading {file_state.filename}",
                                    {
                                        "job_id": job_id,
                                        "filename": file_state.filename,
                                        "file_size": file_state.file_size,
                                        "s3_path": file_state.s3_path,
                                    },
                                )
                                if upload_callback:
                                    upload_callback(job)

                                def byte_callback(uploaded: int, total: int) -> None:
                                    with job.lock:
                                        file_state.bytes_uploaded = uploaded
                                    if upload_callback:
                                        upload_callback(job)

                                upload_result = s3_service.upload_file_with_progress(
                                    s3_client,
                                    file_state.local_path,
                                    s3_bucket,
                                    file_state.s3_path,
                                    byte_callback,
                                )

                                # Handle completion inline
                                file_state.upload_completed_at = datetime.now(UTC)
                                if upload_result["success"]:
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
                                            "upload_duration_seconds": (
                                                file_state.upload_duration_seconds
                                            ),
                                            "s3_path": file_state.s3_path,
                                        },
                                    )
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
                                        logger.debug(
                                            "Cache update failed after upload",
                                            exc_info=True,
                                        )
                                else:
                                    file_state.status = UploadStatus.FAILED
                                    file_state.error_message = upload_result.get(
                                        "error", "Unknown error"
                                    )
                                    log.error(
                                        "upload",
                                        "file_upload_failed",
                                        f"Failed to upload {file_state.filename}: "
                                        f"{file_state.error_message}",
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
                                    {
                                        "job_id": job_id,
                                        "filename": file_state.filename,
                                        "error": str(e),
                                    },
                                )

                            if upload_callback:
                                upload_callback(job)
                            return None

                        return upload_task

                    upload_executor.submit(make_upload_task(fs))

        except Exception as e:
            log.error(
                "upload",
                "pipeline_error",
                f"Pipeline error: {e}",
                {"job_id": job_id, "error": str(e)},
            )
        finally:
            # Wait for all in-flight uploads to complete
            upload_executor.shutdown(wait=True)

        # Final job status
        job.completed_at = datetime.now(UTC)
        if job.cancelled:
            job.status = UploadStatus.CANCELLED
        elif all(f.status in (UploadStatus.COMPLETED, UploadStatus.SKIPPED) for f in job.files):
            job.status = UploadStatus.COMPLETED
        elif any(f.status == UploadStatus.COMPLETED for f in job.files):
            job.status = UploadStatus.COMPLETED  # Partial success
        else:
            job.status = UploadStatus.FAILED

        # Clean up temp directory
        self.cleanup_temp_dir(job_id)

        # Send terminal event IMMEDIATELY so the frontend unblocks.
        # Heavy I/O (logging, CSV, S3 sync) follows below.
        if upload_callback:
            upload_callback(job)

        uploaded_count = sum(1 for f in job.files if f.status == UploadStatus.COMPLETED)
        skipped_count = sum(1 for f in job.files if f.status == UploadStatus.SKIPPED)
        failed_count = sum(1 for f in job.files if f.status == UploadStatus.FAILED)

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
        completed_at = job.completed_at or datetime.now(UTC)
        try:
            log.save_job_jsonl(
                job_id,
                {
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
                },
                completed_at,
            )
        except Exception:
            logger.warning("Failed to save job JSONL summary", exc_info=True)

        # Save upload summary CSV
        try:
            log.save_job_csv(job_id, job, completed_at)
        except Exception:
            logger.warning("Failed to save job CSV summary", exc_info=True)

        # Auto-sync logs to S3
        try:
            log.sync_logs_to_s3(s3_client, s3_bucket)
        except Exception:
            logger.debug("Log sync to S3 failed", exc_info=True)

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
        cache_only: bool = False,
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
            filename_result = cache.check_exists_by_filename(s3_bucket, path.name, stat.st_size)
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
            if cache_only:
                # In cache_only mode, skip S3 HEAD checks — treat misses as not-uploaded
                for idx in cache_miss_indices:
                    files_to_analyze.append(file_statuses[idx]["path"])
            else:
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
                        cache.update_cache(s3_bucket, s3_path, exists, fs["filename"], fs["size"])
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

    def create_scan_job(
        self,
        folder_path: str,
        excluded_subfolders: list[str] | None = None,
        excluded_files: list[str] | None = None,
    ) -> ScanJob:
        """Create a new scan job for a folder.

        Args:
            folder_path: Root folder to scan
            excluded_subfolders: Subfolder names to exclude from scan
            excluded_files: Root-level filenames to exclude from scan

        Returns:
            The created ScanJob
        """
        job_id = str(uuid.uuid4())
        scan_job = ScanJob(
            job_id=job_id,
            root_folder=folder_path,
            excluded_subfolders=excluded_subfolders or [],
            excluded_files=excluded_files or [],
        )
        with self._lock:
            self.scan_jobs[job_id] = scan_job
        return scan_job

    def get_scan_job(self, job_id: str) -> ScanJob | None:
        """Get a scan job by ID."""
        return self.scan_jobs.get(job_id)

    def cancel_scan_job(self, job_id: str) -> bool:
        """Cancel a scan job.

        Args:
            job_id: The scan job ID to cancel

        Returns:
            True if job was found and cancelled
        """
        scan_job = self.get_scan_job(job_id)
        if not scan_job:
            return False
        scan_job.cancelled = True
        scan_job.status = "cancelled"
        return True

    def scan_folder_async(
        self,
        job_id: str,
        s3_bucket: str,
        aws_profile: str,
        aws_region: str,
        progress_callback: Callable[[str, dict[str, Any]], None] | None = None,
        cache_only: bool = False,
    ) -> None:
        """Scan a folder asynchronously, processing subfolder by subfolder.

        Args:
            job_id: The scan job ID
            s3_bucket: S3 bucket for duplicate checking
            aws_profile: AWS profile for S3 access
            aws_region: AWS region for S3 access
            progress_callback: Called with (job_id, event_data) for each event
        """
        scan_job = self.get_scan_job(job_id)
        if not scan_job:
            return

        root = Path(scan_job.root_folder)
        log = get_log_service()

        try:
            # Build exclusion sets for fast lookup
            excluded_subs_set = set(scan_job.excluded_subfolders)
            excluded_files_set = set(scan_job.excluded_files)

            # Phase 1: Enumerate subfolders containing .mcap files (fast, metadata only)
            folder_map: dict[str, list[Path]] = {}
            for mcap_path in root.rglob("*.mcap"):
                if scan_job.cancelled:
                    break
                if mcap_path.is_file():
                    rel = mcap_path.relative_to(root)
                    parts = rel.parts
                    # Skip root-level files in excluded_files list
                    if len(parts) == 1 and parts[0] in excluded_files_set:
                        continue
                    # Skip files under excluded subfolders
                    if len(parts) > 1 and parts[0] in excluded_subs_set:
                        continue
                    parent = str(mcap_path.parent)
                    if parent not in folder_map:
                        folder_map[parent] = []
                    folder_map[parent].append(mcap_path)

            if scan_job.cancelled:
                if progress_callback:
                    progress_callback(
                        job_id,
                        {
                            "type": "scan_complete",
                            "status": "cancelled",
                        },
                    )
                return

            scan_job.folders_total = len(folder_map)

            if progress_callback:
                progress_callback(
                    job_id,
                    {
                        "type": "scan_started",
                        "folders_total": scan_job.folders_total,
                        "root_folder": scan_job.root_folder,
                    },
                )

            # Phase 2: Process each subfolder
            for folder_path_str, mcap_paths in sorted(folder_map.items()):
                if scan_job.cancelled:
                    break

                try:
                    relative_path = str(Path(folder_path_str).relative_to(root))
                    if relative_path == ".":
                        relative_path = "."

                    # Collect file info
                    file_paths: list[str] = []
                    files_info: list[dict[str, Any]] = []
                    folder_size = 0
                    for mcap_path in sorted(mcap_paths, key=lambda p: p.name):
                        stat = mcap_path.stat()
                        file_paths.append(str(mcap_path))
                        folder_size += stat.st_size
                        files_info.append(
                            {
                                "path": str(mcap_path),
                                "filename": mcap_path.name,
                                "size": stat.st_size,
                                "mtime": stat.st_mtime,
                                "relative_path": str(mcap_path.relative_to(root)),
                            }
                        )

                    # Pre-filter this batch for duplicates
                    _, pre_stats = self.pre_filter_files(
                        file_paths,
                        s3_bucket,
                        aws_profile,
                        aws_region,
                        cache_only=cache_only,
                    )

                    # Merge pre-filter results into file info
                    prefilter_map: dict[str, bool] = {}
                    for fs in pre_stats.get("file_statuses", []):
                        prefilter_map[fs["path"]] = fs.get("already_uploaded", False)

                    already_uploaded_count = 0
                    for fi in files_info:
                        fi["already_uploaded"] = prefilter_map.get(fi["path"], False)
                        if fi["already_uploaded"]:
                            already_uploaded_count += 1

                    all_uploaded = already_uploaded_count == len(files_info) and len(files_info) > 0

                    scanned = ScannedFolder(
                        folder_path=folder_path_str,
                        relative_path=relative_path,
                        files=files_info,
                        total_files=len(files_info),
                        already_uploaded=already_uploaded_count,
                        all_uploaded=all_uploaded,
                    )

                except Exception as e:
                    relative_path = str(Path(folder_path_str).relative_to(root))
                    scanned = ScannedFolder(
                        folder_path=folder_path_str,
                        relative_path=relative_path,
                        files=[],
                        error=str(e),
                    )
                    log.error(
                        "scan",
                        "scan_folder_error",
                        f"Error scanning {folder_path_str}: {e}",
                        {"job_id": job_id, "folder": folder_path_str, "error": str(e)},
                    )

                # Build folder dict for both storage and SSE
                folder_dict = {
                    "relative_path": scanned.relative_path,
                    "files": scanned.files,
                    "total_files": scanned.total_files,
                    "already_uploaded": scanned.already_uploaded,
                    "all_uploaded": scanned.all_uploaded,
                    "error": scanned.error,
                }

                # Update running totals and store results
                with scan_job.lock:
                    scan_job.folders_scanned += 1
                    scan_job.total_files_found += scanned.total_files
                    scan_job.total_already_uploaded += scanned.already_uploaded
                    scan_job.total_size += sum(f.get("size", 0) for f in scanned.files)
                    scan_job.scanned_folders.append(folder_dict)

                if progress_callback:
                    progress_callback(
                        job_id,
                        {
                            "type": "scan_folder_complete",
                            "folder": folder_dict,
                            "folders_scanned": scan_job.folders_scanned,
                            "folders_total": scan_job.folders_total,
                            "running_totals": {
                                "total_files_found": scan_job.total_files_found,
                                "total_already_uploaded": scan_job.total_already_uploaded,
                                "total_size": scan_job.total_size,
                            },
                        },
                    )

            # Terminal event
            with scan_job.lock:
                if scan_job.cancelled:
                    scan_job.status = "cancelled"
                else:
                    scan_job.status = "completed"

            if progress_callback:
                progress_callback(
                    job_id,
                    {
                        "type": "scan_complete",
                        "status": scan_job.status,
                        "folders_scanned": scan_job.folders_scanned,
                        "folders_total": scan_job.folders_total,
                        "total_files_found": scan_job.total_files_found,
                        "total_already_uploaded": scan_job.total_already_uploaded,
                        "total_size": scan_job.total_size,
                    },
                )

        except Exception as e:
            scan_job.status = "failed"
            log.error(
                "scan",
                "scan_job_failed",
                f"Scan job {job_id} failed: {e}",
                {"job_id": job_id, "error": str(e)},
            )
            if progress_callback:
                progress_callback(
                    job_id,
                    {
                        "type": "scan_complete",
                        "status": "failed",
                        "error": str(e),
                    },
                )

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
