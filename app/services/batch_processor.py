"""Batch processing infrastructure for handling large upload/delete operations."""

import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from typing import Any

import psutil

logger = logging.getLogger(__name__)


@dataclass
class BatchConfig:
    """Configuration for batch processing behavior."""

    enabled: bool = True
    batch_size: int = 100
    auto_tune_workers: bool = True
    max_workers: int = 4
    target_cpu_percent: float = 70.0
    skip_mcap_validation: bool = False
    use_database_for_large_jobs: bool = True
    large_job_threshold: int = 1000

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BatchConfig":
        """Create BatchConfig from dictionary."""
        return cls(
            enabled=data.get("enabled", True),
            batch_size=data.get("batch_size", 100),
            auto_tune_workers=data.get("auto_tune_workers", True),
            max_workers=data.get("max_workers", 4),
            target_cpu_percent=data.get("target_cpu_percent", 70.0),
            skip_mcap_validation=data.get("skip_mcap_validation", False),
            use_database_for_large_jobs=data.get("use_database_for_large_jobs", True),
            large_job_threshold=data.get("large_job_threshold", 1000),
        )


class BatchStatus(Enum):
    """Status of a batch within a job."""

    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class BatchState:
    """State tracking for an individual batch within a job."""

    batch_id: int
    total_batches: int
    files_in_batch: int
    status: BatchStatus = BatchStatus.PENDING
    files_processed: int = 0
    files_uploaded: int = 0
    files_failed: int = 0
    bytes_uploaded: int = 0
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error_message: str = ""

    @property
    def duration_seconds(self) -> float | None:
        """Calculate batch processing duration in seconds."""
        if self.started_at and self.completed_at:
            return (self.completed_at - self.started_at).total_seconds()
        return None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "batch_id": self.batch_id,
            "total_batches": self.total_batches,
            "files_in_batch": self.files_in_batch,
            "status": self.status.value,
            "files_processed": self.files_processed,
            "files_uploaded": self.files_uploaded,
            "files_failed": self.files_failed,
            "bytes_uploaded": self.bytes_uploaded,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "duration_seconds": self.duration_seconds,
            "error_message": self.error_message,
        }


class WorkerAutoTuner:
    """Monitors system resources and adjusts worker count dynamically."""

    def __init__(
        self,
        target_cpu_percent: float = 70.0,
        check_interval_seconds: float = 30.0,
        max_workers: int = 16,
    ) -> None:
        """Initialize the auto-tuner.

        Args:
            target_cpu_percent: Target CPU utilization (0-100)
            check_interval_seconds: Time between adjustment checks
            max_workers: Maximum allowed workers (hard ceiling)
        """
        self.target_cpu_percent = target_cpu_percent
        self.check_interval_seconds = check_interval_seconds
        self.max_workers = max_workers
        self.cpu_count = os.cpu_count() or 4
        self.last_check_time = 0.0
        self.history: list[dict[str, Any]] = []

    def should_check(self) -> bool:
        """Check if enough time has passed for another adjustment."""
        now = time.time()
        return (now - self.last_check_time) >= self.check_interval_seconds

    def adjust_if_needed(self, current_workers: int) -> int:
        """Adjust worker count based on current system utilization.

        Args:
            current_workers: Current number of workers

        Returns:
            Recommended worker count (may be same as current)
        """
        if not self.should_check():
            return current_workers

        self.last_check_time = time.time()

        # Measure CPU and memory
        try:
            cpu_percent = psutil.cpu_percent(interval=1.0)
            memory_info = psutil.virtual_memory()
            memory_percent = memory_info.percent

            # Record metrics
            self.history.append(
                {
                    "timestamp": time.time(),
                    "cpu_percent": cpu_percent,
                    "memory_percent": memory_percent,
                    "workers": current_workers,
                }
            )

            # Keep only last 10 measurements
            if len(self.history) > 10:
                self.history = self.history[-10:]

            logger.info(
                f"Auto-tuner: CPU={cpu_percent:.1f}%, Memory={memory_percent:.1f}%, "
                f"Workers={current_workers}"
            )

            # Start conservative on first check
            if len(self.history) == 1:
                recommended = min(4, self.cpu_count - 1, self.max_workers)
                logger.info(f"Auto-tuner: Initial worker count: {recommended}")
                return max(2, recommended)

            # Decrease if overloaded
            if cpu_percent > self.target_cpu_percent + 10 or memory_percent > 85:
                new_workers = max(2, current_workers - 1)
                logger.info(
                    f"Auto-tuner: Decreasing workers {current_workers} → {new_workers} "
                    f"(CPU overload or low memory)"
                )
                return new_workers

            # Increase if underutilized
            if cpu_percent < self.target_cpu_percent - 10:
                new_workers = min(
                    current_workers + 2,
                    self.cpu_count,
                    self.max_workers,
                )
                if new_workers > current_workers:
                    logger.info(
                        f"Auto-tuner: Increasing workers {current_workers} → {new_workers} "
                        f"(CPU underutilized)"
                    )
                return new_workers

            # No change needed
            return current_workers

        except Exception as e:
            logger.warning(f"Auto-tuner: Error checking system resources: {e}")
            return current_workers

    def get_metrics(self) -> dict[str, Any]:
        """Get current tuning metrics."""
        if not self.history:
            return {
                "cpu_percent": None,
                "memory_percent": None,
                "workers": None,
                "history_size": 0,
            }

        latest = self.history[-1]
        return {
            "cpu_percent": latest["cpu_percent"],
            "memory_percent": latest["memory_percent"],
            "workers": latest["workers"],
            "history_size": len(self.history),
            "target_cpu_percent": self.target_cpu_percent,
        }


def split_into_batches(items: list[Any], batch_size: int) -> list[list[Any]]:
    """Split a list of items into batches of specified size.

    Args:
        items: List of items to split
        batch_size: Maximum items per batch

    Returns:
        List of batches (each batch is a list of items)

    Example:
        >>> split_into_batches([1, 2, 3, 4, 5], 2)
        [[1, 2], [3, 4], [5]]
    """
    if batch_size <= 0:
        raise ValueError("batch_size must be positive")

    batches = []
    for i in range(0, len(items), batch_size):
        batches.append(items[i : i + batch_size])

    return batches


class BatchProcessor:
    """Orchestrates batch-by-batch processing for large jobs."""

    def __init__(self, config: BatchConfig) -> None:
        """Initialize batch processor.

        Args:
            config: Batch processing configuration
        """
        self.config = config
        self.tuner: WorkerAutoTuner | None = None

        if config.auto_tune_workers:
            self.tuner = WorkerAutoTuner(
                target_cpu_percent=config.target_cpu_percent,
                check_interval_seconds=30.0,
                max_workers=min(config.max_workers, 16),
            )

    def should_use_batch_processing(self, total_files: int) -> bool:
        """Determine if batch processing should be used for this job.

        Args:
            total_files: Total number of files in job

        Returns:
            True if batch processing should be used
        """
        if not self.config.enabled:
            return False

        # Use batch processing for jobs exceeding threshold
        return total_files >= self.config.large_job_threshold

    def create_batches(self, items: list[Any], batch_size: int | None = None) -> list[list[Any]]:
        """Create batches from a list of items.

        Args:
            items: Items to batch
            batch_size: Override default batch size (optional)

        Returns:
            List of batches
        """
        size = batch_size if batch_size is not None else self.config.batch_size
        return split_into_batches(items, size)

    def process_batches(
        self,
        items: list[Any],
        process_fn: Callable[[list[Any], int, int], dict[str, Any]],
        progress_callback: Callable[[BatchState], None] | None = None,
        check_cancelled: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        """Process items in batches with progress tracking.

        Args:
            items: Items to process
            process_fn: Function to process each batch, receives:
                - batch items
                - batch_id (0-indexed)
                - total_batches
                Returns dict with 'success', 'processed', 'failed', 'bytes_uploaded'
            progress_callback: Optional callback for batch progress updates
            check_cancelled: Optional function to check if job was cancelled

        Returns:
            Summary dict with total stats: {
                'success': bool,
                'total_processed': int,
                'total_uploaded': int,
                'total_failed': int,
                'total_bytes': int,
                'batches_completed': int,
                'batches_failed': int,
                'duration_seconds': float
            }
        """
        batches = self.create_batches(items)
        total_batches = len(batches)

        logger.info(
            f"Batch processor: Processing {len(items)} items in {total_batches} batches "
            f"(batch_size={self.config.batch_size})"
        )

        # Tracking stats
        total_processed = 0
        total_uploaded = 0
        total_failed = 0
        total_bytes = 0
        batches_completed = 0
        batches_failed = 0

        start_time = time.time()

        for batch_id, batch_items in enumerate(batches):
            # Check for cancellation
            if check_cancelled and check_cancelled():
                logger.info("Batch processor: Job cancelled by user")
                break

            # Create batch state
            batch_state = BatchState(
                batch_id=batch_id,
                total_batches=total_batches,
                files_in_batch=len(batch_items),
                status=BatchStatus.PROCESSING,
                started_at=datetime.now(UTC),
            )

            # Notify progress callback
            if progress_callback:
                progress_callback(batch_state)

            try:
                # Process this batch
                result = process_fn(batch_items, batch_id, total_batches)

                # Update batch state with results
                batch_state.files_processed = result.get("processed", 0)
                batch_state.files_uploaded = result.get("uploaded", 0)
                batch_state.files_failed = result.get("failed", 0)
                batch_state.bytes_uploaded = result.get("bytes_uploaded", 0)
                batch_state.status = (
                    BatchStatus.COMPLETED if result.get("success") else BatchStatus.FAILED
                )
                batch_state.completed_at = datetime.now(UTC)

                # Update totals
                total_processed += batch_state.files_processed
                total_uploaded += batch_state.files_uploaded
                total_failed += batch_state.files_failed
                total_bytes += batch_state.bytes_uploaded

                if batch_state.status == BatchStatus.COMPLETED:
                    batches_completed += 1
                else:
                    batches_failed += 1

                logger.info(
                    f"Batch {batch_id + 1}/{total_batches} completed: "
                    f"{batch_state.files_uploaded} uploaded, {batch_state.files_failed} failed"
                )

            except Exception as e:
                logger.error(f"Batch {batch_id + 1}/{total_batches} failed: {e}", exc_info=True)
                batch_state.status = BatchStatus.FAILED
                batch_state.error_message = str(e)
                batch_state.completed_at = datetime.now(UTC)
                batches_failed += 1

            # Notify progress callback with final state
            if progress_callback:
                progress_callback(batch_state)

            # Auto-tune workers between batches
            if self.tuner:
                # This would be used by the caller to adjust ThreadPoolExecutor
                new_workers = self.tuner.adjust_if_needed(self.config.max_workers)
                if new_workers != self.config.max_workers:
                    logger.info(f"Auto-tuner recommends {new_workers} workers")

        # Calculate final stats
        duration = time.time() - start_time

        summary = {
            "success": batches_failed == 0,
            "total_processed": total_processed,
            "total_uploaded": total_uploaded,
            "total_failed": total_failed,
            "total_bytes": total_bytes,
            "batches_completed": batches_completed,
            "batches_failed": batches_failed,
            "total_batches": total_batches,
            "duration_seconds": duration,
        }

        logger.info(
            f"Batch processing complete: {batches_completed}/{total_batches} batches succeeded, "
            f"{total_uploaded} items uploaded, {total_failed} failed, "
            f"{duration:.1f}s elapsed"
        )

        return summary

    def get_tuner_metrics(self) -> dict[str, Any]:
        """Get current auto-tuner metrics."""
        if self.tuner:
            return self.tuner.get_metrics()
        return {"enabled": False}
