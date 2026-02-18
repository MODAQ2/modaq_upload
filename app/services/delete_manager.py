"""Delete manager service for local file cleanup after S3 upload."""

import hashlib
import os
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any

from app.services.cache_service import get_cache_service
from app.services.log_service import get_log_service
from app.services.s3_service import create_s3_client, get_object_metadata


class DeleteStatus(Enum):
    """Status for individual files in a delete job."""

    PENDING = "pending"
    SCANNING = "scanning"
    VERIFYING = "verifying"
    VERIFIED = "verified"
    DELETING = "deleting"
    DELETED = "deleted"
    MISMATCH = "mismatch"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class FileDeleteState:
    """State for a single file in a delete job."""

    filename: str
    local_path: str
    file_size: int
    s3_path: str
    s3_bucket: str
    writable: bool = True
    status: DeleteStatus = DeleteStatus.PENDING
    local_md5: str = ""
    s3_etag: str = ""
    s3_size: int = 0
    verification: str = ""
    error_message: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dictionary for API responses."""
        return {
            "filename": self.filename,
            "local_path": self.local_path,
            "file_size": self.file_size,
            "s3_path": self.s3_path,
            "s3_bucket": self.s3_bucket,
            "writable": self.writable,
            "status": self.status.value,
            "local_md5": self.local_md5,
            "s3_etag": self.s3_etag,
            "s3_size": self.s3_size,
            "verification": self.verification,
            "error_message": self.error_message,
        }


@dataclass
class DeleteJob:
    """A delete job tracking multiple files."""

    job_id: str
    files: list[FileDeleteState] = field(default_factory=list)
    status: str = "pending"
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    started_at: str | None = None
    completed_at: str | None = None
    cancelled: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dictionary for API responses."""
        with self.lock:
            status_counts: dict[str, int] = {}
            total_deleted_size = 0
            for f in self.files:
                status_counts[f.status.value] = status_counts.get(f.status.value, 0) + 1
                if f.status == DeleteStatus.DELETED:
                    total_deleted_size += f.file_size

            return {
                "job_id": self.job_id,
                "status": self.status,
                "total_files": len(self.files),
                "files": [f.to_dict() for f in self.files],
                "status_counts": status_counts,
                "total_deleted_size": total_deleted_size,
                "created_at": self.created_at,
                "started_at": self.started_at,
                "completed_at": self.completed_at,
                "cancelled": self.cancelled,
            }

    def to_progress_dict(self) -> dict[str, Any]:
        """Lightweight progress for SSE streaming."""
        with self.lock:
            status_counts: dict[str, int] = {}
            total_deleted_size = 0
            for f in self.files:
                status_counts[f.status.value] = status_counts.get(f.status.value, 0) + 1
                if f.status == DeleteStatus.DELETED:
                    total_deleted_size += f.file_size

            files_processed = sum(
                1
                for f in self.files
                if f.status
                not in (DeleteStatus.PENDING, DeleteStatus.VERIFYING, DeleteStatus.DELETING)
            )

            return {
                "job_id": self.job_id,
                "status": self.status,
                "total_files": len(self.files),
                "files_processed": files_processed,
                "status_counts": status_counts,
                "total_deleted_size": total_deleted_size,
                "cancelled": self.cancelled,
            }


def compute_md5(file_path: str, chunk_size: int = 8 * 1024 * 1024) -> str:
    """Compute MD5 hash of a file in chunks.

    Args:
        file_path: Path to the file
        chunk_size: Read chunk size in bytes (default 8MB)

    Returns:
        Hex-encoded MD5 hash string
    """
    md5 = hashlib.md5()  # noqa: S324
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            md5.update(chunk)
    return md5.hexdigest()


def is_multipart_etag(etag: str) -> bool:
    """Check if an S3 ETag indicates a multipart upload.

    Multipart ETags contain a hyphen followed by the number of parts.

    Args:
        etag: S3 ETag string (already stripped of quotes)

    Returns:
        True if this is a multipart ETag
    """
    return "-" in etag


class DeleteManager:
    """Manages local file deletion jobs with MD5 verification against S3."""

    def __init__(self) -> None:
        self.jobs: dict[str, DeleteJob] = {}

    def scan_folder(
        self,
        folder_path: str,
        bucket: str,
        excluded_subfolders: list[str] | None = None,
        excluded_files: list[str] | None = None,
    ) -> DeleteJob:
        """Scan a folder for .mcap files and cross-reference with upload cache.

        Args:
            folder_path: Local directory to scan
            bucket: S3 bucket to check against
            excluded_subfolders: Subfolder names to skip
            excluded_files: Root-level filenames to skip

        Returns:
            A new DeleteJob with files matched against the cache
        """
        job_id = str(uuid.uuid4())
        job = DeleteJob(job_id=job_id)
        cache = get_cache_service()
        folder = Path(folder_path)
        excluded_subs_set = set(excluded_subfolders or [])
        excluded_files_set = set(excluded_files or [])

        for mcap_path in sorted(folder.rglob("*.mcap")):
            if not mcap_path.is_file():
                continue

            rel = mcap_path.relative_to(folder)
            parts = rel.parts

            # Skip root-level files that are excluded
            if len(parts) == 1 and parts[0] in excluded_files_set:
                continue

            # Skip files under excluded subfolders
            if len(parts) > 1 and parts[0] in excluded_subs_set:
                continue

            stat = mcap_path.stat()
            file_size = stat.st_size
            filename = mcap_path.name

            # Look up in cache
            cache_info = cache.get_uploaded_file_info(bucket, filename, file_size)

            if cache_info is not None:
                file_state = FileDeleteState(
                    filename=filename,
                    local_path=str(mcap_path.absolute()),
                    file_size=file_size,
                    s3_path=str(cache_info["s3_path"]),
                    s3_bucket=bucket,
                    writable=os.access(str(mcap_path), os.W_OK),
                )
                job.files.append(file_state)

        self.jobs[job_id] = job
        return job

    def start_delete_job(
        self,
        job_id: str,
        aws_profile: str,
        aws_region: str,
        progress_callback: Callable[[DeleteJob], None] | None = None,
    ) -> bool:
        """Start verification and deletion for a job.

        Phase 1: Compute local MD5 hashes (parallel)
        Phase 2: Verify against S3 via HEAD — size match (primary) + MD5 (secondary)
        Phase 3: Delete verified files (sequential)

        Args:
            job_id: The job to start
            aws_profile: AWS profile name
            aws_region: AWS region
            progress_callback: Called after each file status change

        Returns:
            True if job was started
        """
        job = self.jobs.get(job_id)
        if not job:
            return False

        with job.lock:
            job.status = "verifying"
            job.started_at = datetime.now(UTC).isoformat()

        log = get_log_service()
        log.info(
            "delete",
            "job_started",
            f"Delete job started: {len(job.files)} files",
            {"job_id": job_id, "total_files": len(job.files)},
        )

        # Phase 1: Compute local MD5 hashes
        def compute_file_md5(file_state: FileDeleteState) -> None:
            if job.cancelled:
                return
            with job.lock:
                file_state.status = DeleteStatus.VERIFYING
            if progress_callback:
                progress_callback(job)

            try:
                file_state.local_md5 = compute_md5(file_state.local_path)
            except Exception as e:
                with job.lock:
                    file_state.status = DeleteStatus.FAILED
                    file_state.error_message = f"MD5 computation failed: {e}"
                log.error(
                    "delete",
                    "md5_failed",
                    f"MD5 failed for {file_state.filename}: {e}",
                    {"file": file_state.filename, "error": str(e)},
                )

        with ThreadPoolExecutor(max_workers=4) as executor:
            executor.map(compute_file_md5, job.files)

        if job.cancelled:
            self._finalize_cancelled(job, progress_callback)
            return True

        # Phase 2: Fetch S3 ETags and compare
        try:
            s3_client = create_s3_client(aws_profile, aws_region)
        except Exception as e:
            with job.lock:
                job.status = "failed"
                job.completed_at = datetime.now(UTC).isoformat()
            log.error(
                "delete",
                "s3_client_failed",
                f"Failed to create S3 client: {e}",
                {"error": str(e)},
            )
            if progress_callback:
                progress_callback(job)
            return True

        def verify_against_s3(file_state: FileDeleteState) -> None:
            """Verify a file against S3 using HEAD + size (primary) and MD5 (secondary).

            Verification levels:
            - "md5+size": S3 exists, size matches, MD5 matches ETag (single-part)
            - "size": S3 exists, size matches, multipart ETag (MD5 not comparable)
            """
            if job.cancelled:
                return
            if file_state.status == DeleteStatus.FAILED:
                return

            try:
                metadata = get_object_metadata(
                    s3_client, file_state.s3_bucket, file_state.s3_path
                )
                if not metadata["success"]:
                    with job.lock:
                        file_state.status = DeleteStatus.FAILED
                        file_state.error_message = (
                            f"S3 object not found: {metadata.get('error', 'unknown')}"
                        )
                    return

                s3_size = int(metadata["size"])
                etag = str(metadata["etag"])
                file_state.s3_etag = etag
                file_state.s3_size = s3_size

                # Primary check: file size must match
                if s3_size != file_state.file_size:
                    with job.lock:
                        file_state.status = DeleteStatus.MISMATCH
                        file_state.error_message = (
                            f"Size mismatch: local={file_state.file_size}, s3={s3_size}"
                        )
                    return

                # Secondary check: MD5 vs ETag (only possible for single-part uploads)
                if is_multipart_etag(etag):
                    # Multipart ETag — can't compare MD5, but size is confirmed
                    with job.lock:
                        file_state.status = DeleteStatus.VERIFIED
                        file_state.verification = "size"
                else:
                    # Single-part ETag — compare MD5
                    if etag == file_state.local_md5:
                        with job.lock:
                            file_state.status = DeleteStatus.VERIFIED
                            file_state.verification = "md5+size"
                    else:
                        with job.lock:
                            file_state.status = DeleteStatus.MISMATCH
                            file_state.error_message = (
                                f"MD5 mismatch: local={file_state.local_md5}, s3={etag}"
                            )
            except Exception as e:
                with job.lock:
                    file_state.status = DeleteStatus.FAILED
                    file_state.error_message = f"S3 verification failed: {e}"

            if progress_callback:
                progress_callback(job)

        with ThreadPoolExecutor(max_workers=4) as executor:
            executor.map(verify_against_s3, job.files)

        if job.cancelled:
            self._finalize_cancelled(job, progress_callback)
            return True

        # Phase 3: Delete verified files (sequential)
        with job.lock:
            job.status = "deleting"
        if progress_callback:
            progress_callback(job)

        for file_state in job.files:
            if job.cancelled:
                self._finalize_cancelled(job, progress_callback)
                return True

            if file_state.status != DeleteStatus.VERIFIED:
                continue

            with job.lock:
                file_state.status = DeleteStatus.DELETING
            if progress_callback:
                progress_callback(job)

            try:
                os.unlink(file_state.local_path)
                with job.lock:
                    file_state.status = DeleteStatus.DELETED
                log.info(
                    "delete",
                    "file_deleted",
                    f"Deleted {file_state.filename}",
                    {
                        "file": file_state.filename,
                        "local_path": file_state.local_path,
                        "s3_path": file_state.s3_path,
                        "size": file_state.file_size,
                    },
                )
            except Exception as e:
                with job.lock:
                    file_state.status = DeleteStatus.FAILED
                    file_state.error_message = f"Delete failed: {e}"
                log.error(
                    "delete",
                    "delete_failed",
                    f"Failed to delete {file_state.filename}: {e}",
                    {"file": file_state.filename, "error": str(e)},
                )

            if progress_callback:
                progress_callback(job)

        # Finalize
        with job.lock:
            job.status = "completed"
            job.completed_at = datetime.now(UTC).isoformat()

        log.info(
            "delete",
            "job_completed",
            f"Delete job completed: {job.to_progress_dict()['status_counts']}",
            {"job_id": job_id, **job.to_progress_dict()["status_counts"]},
        )

        if progress_callback:
            progress_callback(job)

        return True

    def _finalize_cancelled(
        self,
        job: DeleteJob,
        progress_callback: Callable[[DeleteJob], None] | None,
    ) -> None:
        """Mark remaining pending/verifying files as cancelled and finalize."""
        with job.lock:
            for f in job.files:
                if f.status in (
                    DeleteStatus.PENDING,
                    DeleteStatus.VERIFYING,
                    DeleteStatus.VERIFIED,
                ):
                    f.status = DeleteStatus.CANCELLED
            job.status = "cancelled"
            job.completed_at = datetime.now(UTC).isoformat()

        log = get_log_service()
        log.info(
            "delete",
            "job_cancelled",
            "Delete job cancelled",
            {"job_id": job.job_id},
        )

        if progress_callback:
            progress_callback(job)

    def cancel_job(self, job_id: str) -> bool:
        """Cancel a delete job.

        Args:
            job_id: The job to cancel

        Returns:
            True if job was found and cancelled
        """
        job = self.jobs.get(job_id)
        if not job:
            return False
        job.cancelled = True
        return True

    def get_job(self, job_id: str) -> DeleteJob | None:
        """Retrieve a delete job by ID."""
        return self.jobs.get(job_id)


# Global singleton
_delete_manager: DeleteManager | None = None


def get_delete_manager() -> DeleteManager:
    """Get the global delete manager instance."""
    global _delete_manager
    if _delete_manager is None:
        _delete_manager = DeleteManager()
    return _delete_manager
