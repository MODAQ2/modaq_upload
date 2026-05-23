"""Upload manager for orchestrating file uploads to S3."""

import logging
import os
import shutil
import threading
from collections.abc import Callable
from concurrent.futures import (
    FIRST_COMPLETED,
    ProcessPoolExecutor,
    ThreadPoolExecutor,
    as_completed,
    wait,
)
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any

from app.services import file_service, mcap_service, s3_service
from app.services.cache_service import get_cache_service
from app.services.job_models import BaseFileState, BaseJob, BaseJobManager
from app.services.log_service import get_log_service
from app.services.s3_service import UploadCancelledError
from app.services.utils import format_file_size

logger = logging.getLogger(__name__)

# Timestamps before this date are considered invalid (1970/epoch issues)
EPOCH_CUTOFF = datetime(1980, 1, 1, tzinfo=UTC)


def _extract_start_time_worker(local_path: str, skip_validation: bool = False) -> datetime | str:
    """Worker function for ProcessPoolExecutor — must be top-level for pickling.

    Args:
        local_path: Path to the MCAP file
        skip_validation: If True, skip MCAP parsing and extract from filename only

    Returns:
        datetime on success, or error message string on failure.
    """
    try:
        return file_service.extract_timestamp(local_path, skip_validation=skip_validation)
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
class FileUploadState(BaseFileState):
    """State of a single file in an upload job."""

    status: UploadStatus = UploadStatus.PENDING
    s3_path: str = ""
    start_time: datetime | None = None  # MCAP file's data start time
    bytes_uploaded: int = 0
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
            **self._base_dict(),
            "file_size_formatted": format_file_size(self.file_size),
            "status": self.status.value,
            "s3_path": self.s3_path,
            "file_category": file_service.get_file_category(self.filename),
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
class UploadJob(BaseJob):
    """Represents an upload job containing multiple files."""

    status: UploadStatus = UploadStatus.PENDING
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    started_at: datetime | None = None
    completed_at: datetime | None = None
    auto_upload: bool = False  # Auto-start upload when analysis completes
    temp_dir: str | None = None  # Temp directory for cleanup
    pre_filter_stats: dict[str, Any] = field(default_factory=dict)  # Pre-filter statistics

    # Cumulative counters maintained incrementally by set_file_status /
    # set_bytes_uploaded so to_progress_dict() is O(1) in len(files). For 10k+
    # file jobs the prior O(N) sums fired per S3 chunk callback (~1M times)
    # and dominated CPU.
    total_uploaded_bytes: int = 0
    total_files_completed: int = 0  # COMPLETED + SKIPPED (matches legacy files_completed)
    total_files_failed: int = 0
    total_files_skipped: int = 0
    total_files_uploaded: int = 0  # COMPLETED only
    total_bytes_cached: int = 0  # Set once when files are populated

    # SSE throttle state — accessed under ``_progress_lock`` to coalesce
    # per-chunk byte_callback emissions down to ~4 Hz.
    _last_emit_ts: float = 0.0
    _progress_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # When True, terminal per-file transitions are mirrored to JobStorage so the
    # frontend can read per-file results via /api/upload/results without holding
    # 10k rows in browser memory. Set by UploadManager.create_job for large jobs.
    _use_db: bool = False

    @property
    def total_bytes(self) -> int:
        """Total bytes across all files (cached when files are populated)."""
        if self.total_bytes_cached:
            return self.total_bytes_cached
        # Fallback for legacy callers that bypass create_job.
        self.total_bytes_cached = sum(f.file_size for f in self.files)
        return self.total_bytes_cached

    @property
    def uploaded_bytes(self) -> int:
        """Total bytes uploaded across all files (cumulative counter)."""
        return self.total_uploaded_bytes

    @property
    def progress_percent(self) -> float:
        """Overall progress percentage."""
        total = self.total_bytes
        if total == 0:
            return 0.0
        return round(self.total_uploaded_bytes / total * 100, 1)

    @property
    def files_completed(self) -> int:
        """Number of files in a terminal-success state (COMPLETED + SKIPPED)."""
        return self.total_files_completed

    @property
    def files_failed(self) -> int:
        """Number of files failed."""
        return self.total_files_failed

    # ------------------------------------------------------------------
    # State mutation helpers — keep cumulative counters in sync
    # ------------------------------------------------------------------

    def _adjust_counters_for_status(self, status: UploadStatus, sign: int) -> None:
        """Add ``sign`` (+1 or -1) to the counters for ``status``."""
        if status == UploadStatus.COMPLETED:
            self.total_files_completed += sign
            self.total_files_uploaded += sign
        elif status == UploadStatus.SKIPPED:
            self.total_files_completed += sign
            self.total_files_skipped += sign
        elif status == UploadStatus.FAILED:
            self.total_files_failed += sign

    _TERMINAL_STATUSES = frozenset(
        {
            UploadStatus.COMPLETED,
            UploadStatus.FAILED,
            UploadStatus.SKIPPED,
            UploadStatus.CANCELLED,
        }
    )

    def set_file_status(self, file_state: "FileUploadState", new_status: UploadStatus) -> None:
        """Transition a file's status and maintain cumulative counters.

        Idempotent on identical transitions. Use this instead of writing
        ``file_state.status = ...`` directly so counters stay accurate.

        When ``self._use_db`` is True and the transition lands in a terminal
        state, the change is mirrored to JobStorage so the frontend's summary
        phase can lazy-load per-file results without holding them all in
        browser memory. Storage failures are swallowed — bookkeeping must
        never break an in-progress upload.
        """
        old = file_state.status
        if old == new_status:
            return
        self._adjust_counters_for_status(old, -1)
        file_state.status = new_status
        self._adjust_counters_for_status(new_status, +1)

        if self._use_db and new_status in UploadJob._TERMINAL_STATUSES:
            self._persist_file_state(file_state)

    def _persist_file_state(self, file_state: "FileUploadState") -> None:
        """Best-effort mirror of a file's terminal state into JobStorage."""
        try:
            from app.services.job_storage import get_job_storage

            get_job_storage().update_file_status(
                self.job_id,
                file_state.filename,
                file_state.status.value,
                bytes_uploaded=file_state.bytes_uploaded,
                error_message=file_state.error_message or None,
                upload_started_at=file_state.upload_started_at,
                upload_completed_at=file_state.upload_completed_at,
            )
        except Exception:
            logger.debug(
                "JobStorage.update_file_status failed for %s/%s",
                self.job_id,
                file_state.filename,
                exc_info=True,
            )

    def set_bytes_uploaded(self, file_state: "FileUploadState", new_bytes: int) -> None:
        """Set ``file_state.bytes_uploaded`` and bump the cumulative byte counter."""
        delta = new_bytes - file_state.bytes_uploaded
        if delta == 0:
            return
        file_state.bytes_uploaded = new_bytes
        self.total_uploaded_bytes += delta

    @property
    def eta_seconds(self) -> int | None:
        """Estimated time remaining in seconds."""
        uploaded = self.total_uploaded_bytes
        if not self.started_at or uploaded == 0:
            return None

        elapsed = (datetime.now(UTC) - self.started_at).total_seconds()
        if elapsed <= 0:
            return None

        bytes_per_second = uploaded / elapsed
        remaining_bytes = self.total_bytes - uploaded

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

        O(1) in len(files) for all aggregate counters (maintained incrementally
        by set_file_status / set_bytes_uploaded). The active_files slice scans
        until 8 are found and breaks — typically only ~max_workers files are
        active at any moment, so the scan terminates quickly.
        """
        active_files: list[dict[str, Any]] = []
        for f in self.files:
            if f.status in (UploadStatus.UPLOADING, UploadStatus.ANALYZING):
                active_files.append(f.to_dict())
                if len(active_files) >= 8:
                    break
        return {
            "job_id": self.job_id,
            "status": self.status.value,
            "progress_percent": self.progress_percent,
            "files_completed": self.total_files_completed,
            "total_files": len(self.files),
            "uploaded_bytes_formatted": format_file_size(self.total_uploaded_bytes),
            "total_bytes_formatted": format_file_size(self.total_bytes),
            "eta_seconds": self.eta_seconds,
            "files_failed": self.total_files_failed,
            "files_skipped": self.total_files_skipped,
            "files_uploaded": self.total_files_uploaded,
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


class UploadManager(BaseJobManager):
    """Manages upload jobs and their execution."""

    def __init__(self, max_workers: int = 4, batch_config: dict[str, Any] | None = None) -> None:
        super().__init__()
        self.scan_jobs: dict[str, ScanJob] = {}
        self.max_workers = max_workers

        # Load batch processing configuration
        if batch_config is None:
            from app.config import get_settings

            settings = get_settings()
            batch_config = settings.get_batch_config()

        # Import BatchConfig and BatchProcessor
        from app.services.batch_processor import BatchConfig, BatchProcessor

        self.batch_config = BatchConfig.from_dict(batch_config)
        self.batch_processor = (
            BatchProcessor(self.batch_config) if self.batch_config.enabled else None
        )

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
        job_id = self._new_job_id()
        job = UploadJob(job_id=job_id, auto_upload=auto_upload, temp_dir=temp_dir)

        total_bytes = 0
        for path_str in file_paths:
            path = Path(path_str)
            if path.exists():
                size = path.stat().st_size
                file_state = FileUploadState(
                    filename=path.name,
                    local_path=str(path.absolute()),
                    file_size=size,
                )
                job.files.append(file_state)
                total_bytes += size
        job.total_bytes_cached = total_bytes

        # Large jobs: mirror per-file state into SQLite so the summary page can
        # lazy-load results via /api/upload/results without sending all 10k rows
        # over SSE at terminal. Best-effort: save_job failure must not break
        # job creation.
        if (
            self.batch_config.use_database_for_large_jobs
            and len(job.files) >= self.batch_config.large_job_threshold
        ):
            self._save_job_to_storage(job, total_bytes)

        self._register_job(job)

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

    def _save_job_to_storage(self, job: UploadJob, total_bytes: int) -> None:
        """Persist initial job + file rows into SQLite for large jobs.

        Sets ``job._use_db = True`` on success so ``set_file_status`` mirrors
        subsequent terminal transitions. Failure is logged and swallowed —
        bookkeeping must never block job creation.
        """
        try:
            from app.services.job_storage import get_job_storage

            file_states = [
                {
                    "filename": f.filename,
                    "local_path": f.local_path,
                    "file_size": f.file_size,
                    "status": f.status.value,
                    "s3_path": f.s3_path,
                    "start_time": (f.start_time.isoformat() if f.start_time else None),
                    "is_duplicate": f.is_duplicate,
                    "is_valid": f.is_valid,
                }
                for f in job.files
            ]
            get_job_storage().save_job(
                job_id=job.job_id,
                job_type="upload",
                total_files=len(job.files),
                file_states=file_states,
                metadata={"total_bytes": total_bytes},
            )
            job._use_db = True
        except Exception:
            logger.warning(
                "JobStorage.save_job failed for %s; falling back to in-memory only",
                job.job_id,
                exc_info=True,
            )

    def _persist_job_terminal(self, job: UploadJob) -> None:
        """Mirror the job's terminal state to SQLite. Best-effort."""
        if not job._use_db:
            return
        try:
            from app.services.job_storage import get_job_storage

            get_job_storage().update_job_status(
                job_id=job.job_id,
                status=job.status.value,
                files_processed=job.total_files_completed + job.total_files_failed,
                files_uploaded=job.total_files_uploaded,
                files_failed=job.total_files_failed,
                total_bytes=job.total_uploaded_bytes,
                started_at=job.started_at,
                completed_at=job.completed_at,
            )
        except Exception:
            logger.debug("JobStorage.update_job_status failed for %s", job.job_id, exc_info=True)

    def get_job(self, job_id: str) -> UploadJob | None:
        """Get an upload job by ID."""
        return self.jobs.get(job_id)

    def analyze_job(
        self,
        job_id: str,
        aws_profile: str,
        aws_region: str,
        s3_bucket: str,
        skip_validation: bool | None = None,
    ) -> UploadJob | None:
        """Analyze files in a job - extract timestamps and check for duplicates.

        Args:
            job_id: The job ID to analyze
            aws_profile: AWS profile to use
            aws_region: AWS region
            s3_bucket: S3 bucket to check for duplicates
            skip_validation: If True, skip MCAP parsing. If None, use live settings.

        Returns:
            The updated UploadJob or None if not found
        """
        if skip_validation is None:
            from app.config import get_settings

            skip_validation = bool(
                get_settings().batch_processing.get("skip_mcap_validation", False)
            )
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
                job.set_file_status(file_state, UploadStatus.FAILED)
                file_state.error_message = f"Failed to create S3 client: {e}"
            return job

        # Analyze each file
        for file_state in job.files:
            job.set_file_status(file_state, UploadStatus.ANALYZING)
            try:
                # Extract timestamp (supports MCAP and generic files)
                start_time = file_service.extract_timestamp(
                    file_state.local_path, skip_validation=skip_validation
                )
                file_state.start_time = start_time

                # Generate S3 path
                s3_path = file_service.generate_s3_key(file_state.filename, start_time)
                file_state.s3_path = s3_path

                # Check for duplicates
                file_state.is_duplicate = s3_service.check_file_exists(
                    s3_client, s3_bucket, s3_path
                )

                job.set_file_status(file_state, UploadStatus.READY)

            except Exception as e:
                job.set_file_status(file_state, UploadStatus.FAILED)
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
        skip_validation: bool = False,
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
            skip_validation: If True, skip MCAP parsing and extract from filename only

        Returns:
            The updated FileUploadState
        """
        log = get_log_service()
        if job is not None:
            job.set_file_status(file_state, UploadStatus.ANALYZING)
        else:
            file_state.status = UploadStatus.ANALYZING
        if progress_callback and job:
            progress_callback(job, file_state)
        try:
            # Extract timestamp (supports MCAP and generic files)
            start_time = file_service.extract_timestamp(
                file_state.local_path, skip_validation=skip_validation
            )
            file_state.start_time = start_time

            # Check if timestamp is valid (after 1980)
            # Use file_service or mcap_service utility? mcap_service has to_naive_utc.
            # I'll just keep using mcap_service.to_naive_utc as it's a utility.
            from app.services import mcap_service

            naive_start = mcap_service.to_naive_utc(start_time)
            file_state.is_valid = naive_start >= EPOCH_CUTOFF.replace(tzinfo=None)

            # Generate S3 path
            s3_path = file_service.generate_s3_key(file_state.filename, start_time)
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

            if job is not None:
                job.set_file_status(file_state, UploadStatus.READY)
            else:
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
            if job is not None:
                job.set_file_status(file_state, UploadStatus.FAILED)
            else:
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
        skip_validation: bool | None = None,
    ) -> UploadJob | None:
        """Analyze files in a job asynchronously with parallel processing.

        Args:
            job_id: The job ID to analyze
            aws_profile: AWS profile to use
            aws_region: AWS region
            s3_bucket: S3 bucket to check for duplicates
            progress_callback: Optional callback called after each file completes
            use_cache: Whether to use cache for duplicate checking
            skip_validation: If True, skip MCAP parsing. If None, use live settings.

        Returns:
            The updated UploadJob or None if not found
        """
        if skip_validation is None:
            from app.config import get_settings

            skip_validation = bool(
                get_settings().batch_processing.get("skip_mcap_validation", False)
            )
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
                job.set_file_status(file_state, UploadStatus.FAILED)
                file_state.error_message = f"Failed to create S3 client: {e}"
                if progress_callback:
                    progress_callback(job, file_state)
            return job

        # Phase 1: MCAP parsing (CPU-bound) — use ProcessPoolExecutor for true
        # parallelism across cores, bypassing the GIL.
        cpu_workers = max(1, (os.cpu_count() or 4) - 1)
        for file_state in job.files:
            job.set_file_status(file_state, UploadStatus.PENDING)

        files_iter_async = iter(job.files)
        active_async: dict[Any, FileUploadState] = {}

        def _submit_next_async(proc_executor: ProcessPoolExecutor) -> None:
            fs = next(files_iter_async, None)
            if fs is None or job.cancelled:
                return
            job.set_file_status(fs, UploadStatus.ANALYZING)
            if progress_callback:
                progress_callback(job, fs)  # "queued → analyzing" event
            fut = proc_executor.submit(_extract_start_time_worker, fs.local_path, skip_validation)
            active_async[fut] = fs

        with ProcessPoolExecutor(max_workers=cpu_workers) as proc_executor:
            for _ in range(cpu_workers):
                _submit_next_async(proc_executor)

            while active_async:
                if job.cancelled:
                    for f in list(active_async.keys()):
                        f.cancel()
                    break

                done, _ = wait(list(active_async.keys()), return_when=FIRST_COMPLETED)
                for future in done:
                    file_state = active_async.pop(future)
                    result = future.result()
                    if isinstance(result, str):
                        # Error message returned from worker
                        job.set_file_status(file_state, UploadStatus.FAILED)
                        file_state.error_message = result
                        log.error(
                            "analysis",
                            "file_analysis_failed",
                            f"Failed to analyze {file_state.filename}: {result}",
                            {"job_id": job_id, "filename": file_state.filename, "error": result},
                        )
                    else:
                        file_state.start_time = result
                        from app.services import mcap_service

                        naive_start = mcap_service.to_naive_utc(result)
                        file_state.is_valid = naive_start >= EPOCH_CUTOFF.replace(tzinfo=None)
                        file_state.s3_path = file_service.generate_s3_key(
                            file_state.filename, result
                        )
                    if progress_callback:
                        progress_callback(job, file_state)
                    _submit_next_async(proc_executor)

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
                    job.set_file_status(file_state, UploadStatus.READY)
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
                        job.set_file_status(file_state, UploadStatus.FAILED)
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
                    job.set_file_status(file_state, UploadStatus.FAILED)
                    file_state.error_message = f"Failed to create S3 client: {e}"
            return

        log = get_log_service()

        # Filter files to upload
        files_to_upload = []
        for file_state in job.files:
            if file_state.status != UploadStatus.READY:
                continue

            if skip_duplicates and file_state.is_duplicate:
                job.set_file_status(file_state, UploadStatus.SKIPPED)
                job.set_bytes_uploaded(file_state, file_state.file_size)
                log.info(
                    "upload",
                    "file_upload_skipped",
                    f"Skipped duplicate: {file_state.filename}",
                    {"job_id": job_id, "filename": file_state.filename, "reason": "duplicate"},
                )
                continue

            # Skip files with invalid timestamps
            if not file_state.is_valid:
                job.set_file_status(file_state, UploadStatus.SKIPPED)
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
                        if job.cancelled:
                            with job.lock:
                                job.set_file_status(fs, UploadStatus.CANCELLED)
                            return None

                        # Mark UPLOADING inside the worker so files stay READY until picked up
                        with job.lock:
                            job.set_file_status(fs, UploadStatus.UPLOADING)
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
                                job.set_bytes_uploaded(fs, uploaded)
                            if progress_callback:
                                progress_callback(job)

                        return s3_service.upload_file_with_progress(
                            s3_client,
                            fs.local_path,
                            s3_bucket,
                            fs.s3_path,
                            byte_callback,
                            cancel_check=lambda: job.cancelled,
                        )

                    return upload_task

                future = executor.submit(make_upload_task(file_state))
                futures[future] = file_state

            # Process results as they complete
            for future in as_completed(futures):
                file_state = futures[future]
                try:
                    result = future.result()
                    if result is None:
                        # Task was cancelled before starting
                        continue
                    file_state.upload_completed_at = datetime.now(UTC)
                    if result["success"]:
                        job.set_file_status(file_state, UploadStatus.COMPLETED)
                        job.set_bytes_uploaded(file_state, file_state.file_size)
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
                        job.set_file_status(file_state, UploadStatus.FAILED)
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
                except UploadCancelledError:
                    with job.lock:
                        job.set_file_status(file_state, UploadStatus.CANCELLED)
                        file_state.upload_completed_at = datetime.now(UTC)
                except Exception as e:
                    file_state.upload_completed_at = datetime.now(UTC)
                    job.set_file_status(file_state, UploadStatus.FAILED)
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

        # Mirror terminal job state to SQLite for large jobs (best-effort).
        self._persist_job_terminal(job)

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
        skip_validation: bool | None = None,
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
            skip_validation: If True, skip MCAP parsing. If None, use batch_config setting
        """
        # Determine skip_validation setting — read live from settings so that
        # changes made in the Settings UI take effect without a server restart.
        # (UploadManager is a singleton whose batch_config is frozen at init time.)
        if skip_validation is None:
            from app.config import get_settings

            skip_validation = bool(
                get_settings().batch_processing.get("skip_mcap_validation", False)
            )
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
                job.set_file_status(file_state, UploadStatus.FAILED)
                file_state.error_message = f"Failed to create S3 client: {e}"
                if analysis_callback:
                    analysis_callback(job, file_state)
            if upload_callback:
                upload_callback(job)
            return

        cpu_workers = max(1, (os.cpu_count() or 4) - 1)
        upload_executor = ThreadPoolExecutor(max_workers=self.max_workers)

        # Mark all files as PENDING (waiting their turn in the analysis pool)
        for fs in job.files:
            job.set_file_status(fs, UploadStatus.PENDING)

        files_iter = iter(job.files)
        active: dict[Any, FileUploadState] = {}

        def _submit_next(proc_executor: ProcessPoolExecutor) -> None:
            fs = next(files_iter, None)
            if fs is None or job.cancelled:
                return
            job.set_file_status(fs, UploadStatus.ANALYZING)
            if analysis_callback:
                analysis_callback(job, fs)  # "queued → analyzing" event
            fut = proc_executor.submit(_extract_start_time_worker, fs.local_path, skip_validation)
            active[fut] = fs

        try:
            with ProcessPoolExecutor(max_workers=cpu_workers) as proc_executor:
                # Fill initial slots
                for _ in range(cpu_workers):
                    _submit_next(proc_executor)

                while active:
                    if job.cancelled:
                        for f in list(active.keys()):
                            f.cancel()
                        break

                    done, _ = wait(list(active.keys()), return_when=FIRST_COMPLETED)
                    for future in done:
                        fs = active.pop(future)
                        result = future.result()

                        if isinstance(result, str):
                            # Parse failed
                            job.set_file_status(fs, UploadStatus.FAILED)
                            fs.error_message = result
                            log.error(
                                "analysis",
                                "file_analysis_failed",
                                f"Failed to analyze {fs.filename}: {result}",
                                {"job_id": job_id, "filename": fs.filename, "error": result},
                            )
                            if analysis_callback:
                                analysis_callback(job, fs)
                            _submit_next(proc_executor)
                            continue

                        # Parse succeeded — set timestamp and generate S3 path
                        fs.start_time = result
                        naive_start = mcap_service.to_naive_utc(result)
                        fs.is_valid = naive_start >= EPOCH_CUTOFF.replace(tzinfo=None)
                        fs.s3_path = mcap_service.generate_s3_path(result, fs.filename)

                        # Check duplicate (I/O but fast — cache lookup or S3 HEAD)
                        self._check_duplicate(fs, s3_client, s3_bucket, use_cache)
                        job.set_file_status(fs, UploadStatus.READY)

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

                        # Fill freed slot immediately
                        _submit_next(proc_executor)

                        # Decide: skip or upload?
                        if not fs.is_valid:
                            job.set_file_status(fs, UploadStatus.SKIPPED)
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
                            job.set_file_status(fs, UploadStatus.SKIPPED)
                            job.set_bytes_uploaded(fs, fs.file_size)
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
                                        job.set_file_status(file_state, UploadStatus.CANCELLED)
                                    if analysis_callback:
                                        analysis_callback(job, file_state)
                                    if upload_callback:
                                        upload_callback(job)
                                    return None

                                try:
                                    with job.lock:
                                        job.set_file_status(file_state, UploadStatus.UPLOADING)
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
                                            job.set_bytes_uploaded(file_state, uploaded)
                                        if upload_callback:
                                            upload_callback(job)

                                    upload_result = s3_service.upload_file_with_progress(
                                        s3_client,
                                        file_state.local_path,
                                        s3_bucket,
                                        file_state.s3_path,
                                        byte_callback,
                                        cancel_check=lambda: job.cancelled,
                                    )

                                    # Handle completion inline
                                    file_state.upload_completed_at = datetime.now(UTC)
                                    if upload_result["success"]:
                                        job.set_file_status(file_state, UploadStatus.COMPLETED)
                                        job.set_bytes_uploaded(file_state, file_state.file_size)
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
                                        job.set_file_status(file_state, UploadStatus.FAILED)
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
                                except UploadCancelledError:
                                    with job.lock:
                                        job.set_file_status(file_state, UploadStatus.CANCELLED)
                                        file_state.upload_completed_at = datetime.now(UTC)
                                except Exception as e:
                                    file_state.upload_completed_at = datetime.now(UTC)
                                    job.set_file_status(file_state, UploadStatus.FAILED)
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

                                # Notify per-file status so the frontend
                                # updates this row immediately (the progress
                                # dict only includes active files, so without
                                # this the row would keep spinning).
                                if analysis_callback:
                                    analysis_callback(job, file_state)
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
            # Wait for ALL uploads (in-flight + queued) to complete
            upload_executor.shutdown(wait=True)

            # Mark any files still in non-terminal states as cancelled
            if job.cancelled:
                with job.lock:
                    for fs in job.files:
                        if fs.status in (
                            UploadStatus.PENDING,
                            UploadStatus.READY,
                            UploadStatus.ANALYZING,
                            UploadStatus.UPLOADING,
                        ):
                            job.set_file_status(fs, UploadStatus.CANCELLED)

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

        # Mirror terminal job state to SQLite for large jobs (best-effort).
        self._persist_job_terminal(job)

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

    def _on_cancel(self, job: Any) -> None:
        """Upload-specific cancel logic: mark pending files cancelled, clean up temp dir."""
        upload_job = job  # type: UploadJob
        with upload_job.lock:
            for file_state in upload_job.files:
                if file_state.status in (
                    UploadStatus.PENDING,
                    UploadStatus.READY,
                    UploadStatus.ANALYZING,
                ):
                    upload_job.set_file_status(file_state, UploadStatus.CANCELLED)

        self.cleanup_temp_dir(upload_job.job_id)

        log = get_log_service()
        log.warning(
            "upload",
            "upload_job_cancelled",
            f"Upload job {upload_job.job_id} cancelled",
            {"job_id": upload_job.job_id},
        )

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

            # Try to extract timestamp (fast, no file I/O if in filename)
            # Use mcap_service._extract_timestamp_from_filename utility directly?
            # Or assume file_service handles it?
            # file_service.extract_timestamp does I/O (stat/parse).
            # We want FAST pre-filtering.
            # We can use the regex utility from mcap_service for filenames.
            from app.services import mcap_service

            timestamp = mcap_service._extract_timestamp_from_filename(path.name)

            if timestamp is None:
                # Can't extract timestamp from filename, need full analysis
                # (This is true for generic files without timestamps in names too)
                stats["no_timestamp"] += 1
                files_to_analyze.append(file_path)
                file_statuses.append(file_status)
                continue

            # Generate S3 path from filename timestamp
            s3_path = file_service.generate_s3_key(path.name, timestamp)
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
        job_id = self._new_job_id()
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
        """Scan a folder asynchronously, emitting SSE events per subfolder as discovered.

        Uses os.walk so that ``scan_started`` fires immediately and
        ``scan_folder_complete`` events stream in as each folder is processed,
        giving real-time UI feedback even on first (cold-cache) scans.

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

        from app.config import get_settings

        allowed_extensions = set(get_settings().allowed_extensions)

        try:
            # Build exclusion sets for fast lookup
            excluded_subs_set = set(scan_job.excluded_subfolders)
            excluded_files_set = set(scan_job.excluded_files)

            # Emit scan_started immediately so the UI knows scanning has begun.
            # folders_total is 0 (unknown) at this point; the modal shows
            # live stats without a percentage bar until we're done.
            if progress_callback:
                progress_callback(
                    job_id,
                    {
                        "type": "scan_started",
                        "folders_total": 0,
                        "root_folder": scan_job.root_folder,
                    },
                )

            # Walk the directory tree on-the-fly.  topdown=True lets us prune
            # excluded top-level subfolders before os.walk descends into them,
            # which is more efficient than the previous post-filter approach.
            for dirpath_str, dirnames, filenames in os.walk(str(root), topdown=True):
                if scan_job.cancelled:
                    break

                dirpath = Path(dirpath_str)
                rel_dir = dirpath.relative_to(root)

                # Prune excluded top-level subfolders from traversal
                if rel_dir == Path("."):
                    dirnames[:] = [d for d in dirnames if d not in excluded_subs_set]

                # Collect allowed files in this directory
                folder_path_str = dirpath_str
                mcap_paths = []
                for fname in sorted(filenames):
                    # Skip excluded root-level files
                    if rel_dir == Path(".") and fname in excluded_files_set:
                        continue
                    ext = Path(fname).suffix.lower().lstrip(".")
                    if ext in allowed_extensions:
                        mcap_paths.append(dirpath / fname)

                # Sort subdirectory traversal order for deterministic results;
                # must happen before any `continue` so os.walk enters them in order.
                dirnames.sort()

                if not mcap_paths:
                    continue  # No matching files in this directory — skip

                try:
                    relative_path = str(Path(folder_path_str).relative_to(root))
                    if relative_path == ".":
                        relative_path = "."

                    # Collect file info
                    file_paths: list[str] = []
                    files_info: list[dict[str, Any]] = []
                    folder_size = 0
                    for file_path in sorted(mcap_paths, key=lambda p: p.name):
                        stat = file_path.stat()
                        file_paths.append(str(file_path))
                        folder_size += stat.st_size
                        files_info.append(
                            {
                                "path": str(file_path),
                                "filename": file_path.name,
                                "size": stat.st_size,
                                "mtime": stat.st_mtime,
                                "relative_path": str(file_path.relative_to(root)),
                                "file_category": file_service.get_file_category(file_path.name),
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
                # folders_total was 0 at scan_started (unknown); set it to the
                # actual count now that the walk is complete.
                scan_job.folders_total = scan_job.folders_scanned

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


# Global upload manager instance
_upload_manager: UploadManager | None = None


def get_upload_manager() -> UploadManager:
    """Get the global upload manager instance."""
    global _upload_manager
    if _upload_manager is None:
        _upload_manager = UploadManager()
    return _upload_manager
