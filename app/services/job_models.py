"""Shared base classes for upload and delete job models.

Provides:
- ``BaseFileState``: common fields and helpers for per-file state objects.
- ``BaseJob``: common fields and helpers for job container dataclasses.
- ``BaseJobManager``: common job registry, ``get_job``, ``cancel_job``, and
  ``cleanup_old_jobs`` shared by ``UploadManager`` and ``DeleteManager``.
"""

import threading
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

# ---------------------------------------------------------------------------
# File state base
# ---------------------------------------------------------------------------


@dataclass
class BaseFileState:
    """Common fields for per-file workflow state (upload or delete).

    Subclasses add workflow-specific fields and call ``_base_dict()`` from
    their own ``to_dict()`` implementation.
    """

    filename: str
    local_path: str
    file_size: int
    error_message: str = ""

    def _base_dict(self) -> dict[str, Any]:
        """Return the fields shared across all file state types."""
        return {
            "filename": self.filename,
            "local_path": self.local_path,
            "file_size": self.file_size,
            "error_message": self.error_message,
        }


# ---------------------------------------------------------------------------
# Job container base
# ---------------------------------------------------------------------------


@dataclass
class BaseJob:
    """Common fields and helpers for job container dataclasses.

    Both ``UploadJob`` and ``DeleteJob`` inherit from this. Subclasses keep
    their own ``status`` field (UploadJob uses an Enum, DeleteJob uses str)
    and override ``to_dict()`` / ``to_progress_dict()`` as needed.
    """

    job_id: str
    files: list[Any] = field(default_factory=list)
    cancelled: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def _compute_status_counts(self) -> dict[str, int]:
        """Count files by status value.

        Works for both Enum-based statuses (``f.status.value``) and plain
        string statuses.
        """
        counts: dict[str, int] = {}
        for f in self.files:
            val: str = f.status.value if hasattr(f.status, "value") else str(f.status)
            counts[val] = counts.get(val, 0) + 1
        return counts


# ---------------------------------------------------------------------------
# Job manager base
# ---------------------------------------------------------------------------


class BaseJobManager:
    """Common job registry for upload and delete managers.

    Provides thread-safe job registration, lookup, cancellation, and
    age-based cleanup. Subclasses implement workflow-specific logic by
    overriding ``_on_cancel`` and optionally ``_completed_at_datetime``.
    """

    def __init__(self) -> None:
        self.jobs: dict[str, Any] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Registry
    # ------------------------------------------------------------------

    def _register_job(self, job: Any) -> None:
        """Add a job to the registry."""
        with self._lock:
            self.jobs[job.job_id] = job

    def get_job(self, job_id: str) -> Any | None:
        """Return a job by ID, or None if not found."""
        return self.jobs.get(job_id)

    # ------------------------------------------------------------------
    # Cancellation
    # ------------------------------------------------------------------

    def cancel_job(self, job_id: str) -> bool:
        """Set ``job.cancelled = True`` and call ``_on_cancel``.

        Returns:
            True if the job was found (and cancellation flagged).
        """
        job = self.get_job(job_id)
        if not job:
            return False
        job.cancelled = True
        self._on_cancel(job)
        return True

    def _on_cancel(self, job: Any) -> None:
        """Hook called after ``cancelled`` is set. Override for cleanup."""

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    def _completed_at_datetime(self, job: Any) -> datetime | None:
        """Return ``job.completed_at`` as a timezone-aware datetime, or None.

        Handles both ``datetime`` objects (UploadJob) and ISO 8601 strings
        (DeleteJob) transparently.
        """
        ca = job.completed_at
        if ca is None:
            return None
        if isinstance(ca, datetime):
            return ca if ca.tzinfo else ca.replace(tzinfo=UTC)
        try:
            return datetime.fromisoformat(str(ca))
        except (ValueError, TypeError):
            return None

    def cleanup_old_jobs(self, max_age_seconds: int = 3600) -> int:
        """Remove completed jobs older than ``max_age_seconds`` from memory.

        Returns:
            Number of jobs removed.
        """
        now = datetime.now(UTC)
        removed = 0
        with self._lock:
            to_remove = [
                job_id
                for job_id, job in self.jobs.items()
                if (completed_at := self._completed_at_datetime(job)) is not None
                and (now - completed_at).total_seconds() > max_age_seconds
            ]
            for job_id in to_remove:
                del self.jobs[job_id]
                removed += 1
        return removed

    # ------------------------------------------------------------------
    # Convenience
    # ------------------------------------------------------------------

    @staticmethod
    def _new_job_id() -> str:
        """Generate a new unique job ID."""
        return str(uuid.uuid4())
