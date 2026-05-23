"""Integration: UploadJob/UploadManager mirror per-file state into JobStorage for large jobs."""

import tempfile
from collections.abc import Generator
from pathlib import Path
from unittest.mock import patch

import pytest

from app.services import job_storage
from app.services.job_storage import JobStorage
from app.services.upload_manager import (
    FileUploadState,
    UploadJob,
    UploadManager,
    UploadStatus,
)


@pytest.fixture
def isolated_storage() -> Generator[JobStorage, None, None]:
    """Point JobStorage at a fresh temp DB and reset its singleton.

    JobStorage is a singleton tied to a module-level DB_FILE. We override
    both to a tempfile so the test doesn't pollute the real database.
    """
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    tmp_path = Path(tmp.name)

    original_db_file = job_storage.DB_FILE
    original_instance = JobStorage._instance
    job_storage.DB_FILE = tmp_path  # type: ignore[misc]
    JobStorage._instance = None

    storage = JobStorage()
    try:
        yield storage
    finally:
        # Restore globals so other tests aren't affected.
        JobStorage._instance = original_instance
        job_storage.DB_FILE = original_db_file  # type: ignore[misc]
        if tmp_path.exists():
            tmp_path.unlink()


def _make_large_job_manager(threshold: int = 3) -> UploadManager:
    """Build an UploadManager whose batch_config treats >=3 files as 'large'."""
    return UploadManager(
        batch_config={
            "enabled": True,
            "use_database_for_large_jobs": True,
            "large_job_threshold": threshold,
        }
    )


def _make_real_files(n: int) -> list[Path]:
    """Create n tiny temp files so UploadManager.create_job accepts them."""
    paths: list[Path] = []
    tmpdir = Path(tempfile.mkdtemp(prefix="modaq_storage_test_"))
    for i in range(n):
        p = tmpdir / f"file_{i:04d}.mcap"
        p.write_bytes(b"x" * (100 + i))
        paths.append(p)
    return paths


class TestLargeJobPersistence:
    def test_create_job_above_threshold_writes_to_db(
        self, isolated_storage: JobStorage
    ) -> None:
        manager = _make_large_job_manager(threshold=3)
        paths = _make_real_files(5)
        try:
            job = manager.create_job([str(p) for p in paths])
            assert job._use_db is True
            persisted = isolated_storage.get_job(job.job_id)
            assert persisted is not None
            assert persisted["total_files"] == 5
            assert persisted["status"] == "pending"
            results = isolated_storage.get_job_results(job.job_id, per_page=10)
            assert len(results["files"]) == 5
        finally:
            for p in paths:
                if p.exists():
                    p.unlink()
            paths[0].parent.rmdir()

    def test_below_threshold_does_not_use_db(
        self, isolated_storage: JobStorage
    ) -> None:
        manager = _make_large_job_manager(threshold=10)
        paths = _make_real_files(3)
        try:
            job = manager.create_job([str(p) for p in paths])
            assert job._use_db is False
            # Job should NOT have been saved
            assert isolated_storage.get_job(job.job_id) is None
        finally:
            for p in paths:
                if p.exists():
                    p.unlink()
            paths[0].parent.rmdir()

    def test_terminal_file_transitions_mirror_to_db(
        self, isolated_storage: JobStorage
    ) -> None:
        manager = _make_large_job_manager(threshold=3)
        paths = _make_real_files(4)
        try:
            job = manager.create_job([str(p) for p in paths])
            # Transition two files to COMPLETED, one to FAILED
            job.set_bytes_uploaded(job.files[0], job.files[0].file_size)
            job.set_file_status(job.files[0], UploadStatus.COMPLETED)
            job.set_bytes_uploaded(job.files[1], job.files[1].file_size)
            job.set_file_status(job.files[1], UploadStatus.COMPLETED)
            job.files[2].error_message = "boom"
            job.set_file_status(job.files[2], UploadStatus.FAILED)

            results = isolated_storage.get_job_results(job.job_id, per_page=10)
            by_name = {f["filename"]: f for f in results["files"]}
            assert by_name[paths[0].name]["status"] == "completed"
            assert by_name[paths[0].name]["bytes_uploaded"] == paths[0].stat().st_size
            assert by_name[paths[1].name]["status"] == "completed"
            assert by_name[paths[2].name]["status"] == "failed"
            assert by_name[paths[2].name]["error_message"] == "boom"
            # The 4th file is still pending — no terminal transition fired
            assert by_name[paths[3].name]["status"] == "pending"
        finally:
            for p in paths:
                if p.exists():
                    p.unlink()
            paths[0].parent.rmdir()

    def test_persist_job_terminal_updates_job_row(
        self, isolated_storage: JobStorage
    ) -> None:
        manager = _make_large_job_manager(threshold=3)
        paths = _make_real_files(3)
        try:
            job = manager.create_job([str(p) for p in paths])
            from datetime import UTC, datetime

            job.started_at = datetime.now(UTC)
            for f in job.files:
                job.set_bytes_uploaded(f, f.file_size)
                job.set_file_status(f, UploadStatus.COMPLETED)
            job.status = UploadStatus.COMPLETED
            job.completed_at = datetime.now(UTC)
            manager._persist_job_terminal(job)

            persisted = isolated_storage.get_job(job.job_id)
            assert persisted is not None
            assert persisted["status"] == "completed"
            assert persisted["files_uploaded"] == 3
            assert persisted["files_failed"] == 0
            assert persisted["total_bytes"] == sum(p.stat().st_size for p in paths)
        finally:
            for p in paths:
                if p.exists():
                    p.unlink()
            paths[0].parent.rmdir()


class TestStorageHookFailureTolerance:
    def test_storage_failure_does_not_break_status_transitions(
        self, isolated_storage: JobStorage
    ) -> None:
        """If JobStorage.update_file_status raises, the in-memory transition still happens."""
        manager = _make_large_job_manager(threshold=2)
        paths = _make_real_files(2)
        try:
            job = manager.create_job([str(p) for p in paths])
            with patch.object(
                isolated_storage,
                "update_file_status",
                side_effect=RuntimeError("db down"),
            ):
                job.set_file_status(job.files[0], UploadStatus.COMPLETED)
            # In-memory state still progressed
            assert job.files[0].status == UploadStatus.COMPLETED
            assert job.total_files_uploaded == 1
        finally:
            for p in paths:
                if p.exists():
                    p.unlink()
            paths[0].parent.rmdir()


class TestSetFileStatusIgnoresDbWhenFlagOff:
    def test_use_db_false_means_no_storage_calls(
        self, isolated_storage: JobStorage
    ) -> None:
        """A standalone UploadJob with _use_db=False never touches storage."""
        job = UploadJob(job_id="lonely-job")
        job.files.append(FileUploadState("f1", "/p/f1", 100))
        # No save_job, no _use_db
        with patch.object(isolated_storage, "update_file_status") as mock_update:
            job.set_file_status(job.files[0], UploadStatus.COMPLETED)
        mock_update.assert_not_called()
