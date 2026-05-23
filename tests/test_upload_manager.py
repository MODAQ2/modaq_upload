"""Tests for the upload manager module."""

from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

from app.services.upload_manager import (
    FileUploadState,
    UploadJob,
    UploadManager,
    UploadStatus,
    get_upload_manager,
)


class TestUploadStatus:
    """Tests for UploadStatus enum."""

    def test_all_statuses_have_values(self) -> None:
        """Test that all statuses have string values."""
        assert UploadStatus.PENDING.value == "pending"
        assert UploadStatus.ANALYZING.value == "analyzing"
        assert UploadStatus.READY.value == "ready"
        assert UploadStatus.UPLOADING.value == "uploading"
        assert UploadStatus.COMPLETED.value == "completed"
        assert UploadStatus.FAILED.value == "failed"
        assert UploadStatus.SKIPPED.value == "skipped"
        assert UploadStatus.CANCELLED.value == "cancelled"


class TestFileUploadState:
    """Tests for FileUploadState dataclass."""

    def test_default_values(self) -> None:
        """Test default values for FileUploadState."""
        state = FileUploadState(
            filename="test.mcap", local_path="/path/to/test.mcap", file_size=1000
        )

        assert state.status == UploadStatus.PENDING
        assert state.s3_path == ""
        assert state.start_time is None
        assert state.bytes_uploaded == 0
        assert state.error_message == ""
        assert state.is_duplicate is False

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        state = FileUploadState(
            filename="test.mcap",
            local_path="/path/to/test.mcap",
            file_size=1024 * 1024,  # 1 MB
            status=UploadStatus.UPLOADING,
            bytes_uploaded=512 * 1024,  # 512 KB
        )

        result = state.to_dict()

        assert result["filename"] == "test.mcap"
        assert result["status"] == "uploading"
        assert result["progress_percent"] == 50.0
        assert "MB" in result["file_size_formatted"]

    def test_progress_percent_zero_size(self) -> None:
        """Test progress calculation with zero file size."""
        state = FileUploadState(filename="empty.mcap", local_path="/path/empty.mcap", file_size=0)

        result = state.to_dict()
        assert result["progress_percent"] == 0


class TestUploadJob:
    """Tests for UploadJob dataclass."""

    def test_total_bytes(self) -> None:
        """Test total_bytes property."""
        job = UploadJob(job_id="test-job")
        job.files = [
            FileUploadState("f1.mcap", "/p/f1.mcap", 1000),
            FileUploadState("f2.mcap", "/p/f2.mcap", 2000),
            FileUploadState("f3.mcap", "/p/f3.mcap", 3000),
        ]

        assert job.total_bytes == 6000

    def test_uploaded_bytes(self) -> None:
        """Test uploaded_bytes property (cumulative counter)."""
        job = UploadJob(job_id="test-job")
        job.files = [
            FileUploadState("f1.mcap", "/p/f1.mcap", 1000),
            FileUploadState("f2.mcap", "/p/f2.mcap", 2000),
        ]
        job.set_bytes_uploaded(job.files[0], 500)
        job.set_bytes_uploaded(job.files[1], 1000)

        assert job.uploaded_bytes == 1500
        assert job.total_uploaded_bytes == 1500

    def test_progress_percent(self) -> None:
        """Test progress_percent property."""
        job = UploadJob(job_id="test-job")
        job.files = [
            FileUploadState("f1.mcap", "/p/f1.mcap", 1000),
            FileUploadState("f2.mcap", "/p/f2.mcap", 1000),
        ]
        job.total_bytes_cached = 2000
        job.set_bytes_uploaded(job.files[0], 1000)
        job.set_bytes_uploaded(job.files[1], 500)

        assert job.progress_percent == 75.0

    def test_progress_percent_empty(self) -> None:
        """Test progress_percent with no files."""
        job = UploadJob(job_id="test-job")
        assert job.progress_percent == 0.0

    def test_files_completed(self) -> None:
        """Test files_completed property (COMPLETED + SKIPPED)."""
        job = UploadJob(job_id="test-job")
        job.files = [
            FileUploadState("f1.mcap", "/p/f1.mcap", 1000),
            FileUploadState("f2.mcap", "/p/f2.mcap", 1000),
            FileUploadState("f3.mcap", "/p/f3.mcap", 1000),
        ]
        job.set_file_status(job.files[0], UploadStatus.COMPLETED)
        job.set_file_status(job.files[1], UploadStatus.SKIPPED)
        job.set_file_status(job.files[2], UploadStatus.UPLOADING)

        assert job.files_completed == 2
        assert job.total_files_uploaded == 1  # COMPLETED only
        assert job.total_files_skipped == 1

    def test_files_failed(self) -> None:
        """Test files_failed property."""
        job = UploadJob(job_id="test-job")
        job.files = [
            FileUploadState("f1.mcap", "/p/f1.mcap", 1000),
            FileUploadState("f2.mcap", "/p/f2.mcap", 1000),
        ]
        job.set_file_status(job.files[0], UploadStatus.FAILED)
        job.set_file_status(job.files[1], UploadStatus.COMPLETED)

        assert job.files_failed == 1
        assert job.total_files_failed == 1
        assert job.total_files_uploaded == 1

    def test_eta_seconds_not_started(self) -> None:
        """Test ETA when upload hasn't started."""
        job = UploadJob(job_id="test-job")
        assert job.eta_seconds is None

    def test_eta_seconds_no_progress(self) -> None:
        """Test ETA with no bytes uploaded."""
        job = UploadJob(job_id="test-job")
        job.started_at = datetime.now()
        job.files = [FileUploadState("f1.mcap", "/p/f1.mcap", 1000)]

        assert job.eta_seconds is None

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        job = UploadJob(job_id="test-job-123")
        job.files = [FileUploadState("f1.mcap", "/p/f1.mcap", 1000)]

        result = job.to_dict()

        assert result["job_id"] == "test-job-123"
        assert result["total_files"] == 1
        assert "files" in result
        assert len(result["files"]) == 1

    # ------------------------------------------------------------------
    # Cumulative-counter invariants
    # ------------------------------------------------------------------

    def test_cumulative_counters_match_status_counts(self) -> None:
        """After a sequence of transitions, counters equal a direct status scan."""
        job = UploadJob(job_id="test-job")
        for i in range(10):
            job.files.append(FileUploadState(f"f{i}", f"/p/f{i}", 100))
        # Simulate a mixed terminal-state run.
        for i in range(5):
            job.set_file_status(job.files[i], UploadStatus.COMPLETED)
        for i in range(5, 7):
            job.set_file_status(job.files[i], UploadStatus.SKIPPED)
        for i in range(7, 9):
            job.set_file_status(job.files[i], UploadStatus.FAILED)
        # job.files[9] stays PENDING

        assert job.total_files_uploaded == 5
        assert job.total_files_skipped == 2
        assert job.total_files_failed == 2
        # files_completed counts COMPLETED + SKIPPED (legacy semantics)
        assert job.total_files_completed == 7
        # Cross-check against an O(N) scan
        assert job.total_files_uploaded == sum(
            1 for f in job.files if f.status == UploadStatus.COMPLETED
        )
        assert job.total_files_failed == sum(
            1 for f in job.files if f.status == UploadStatus.FAILED
        )

    def test_set_file_status_is_idempotent(self) -> None:
        """Re-applying the same status must not double-count."""
        job = UploadJob(job_id="x")
        fs = FileUploadState("f1", "/p/f1", 100)
        job.files.append(fs)
        job.set_file_status(fs, UploadStatus.COMPLETED)
        job.set_file_status(fs, UploadStatus.COMPLETED)
        job.set_file_status(fs, UploadStatus.COMPLETED)
        assert job.total_files_uploaded == 1
        assert job.total_files_completed == 1

    def test_set_file_status_transitions_between_terminals(self) -> None:
        """Reclassifying a terminal file (e.g. FAILED -> COMPLETED) keeps counters consistent."""
        job = UploadJob(job_id="x")
        fs = FileUploadState("f1", "/p/f1", 100)
        job.files.append(fs)
        job.set_file_status(fs, UploadStatus.FAILED)
        assert job.total_files_failed == 1
        assert job.total_files_uploaded == 0
        job.set_file_status(fs, UploadStatus.COMPLETED)
        assert job.total_files_failed == 0
        assert job.total_files_uploaded == 1

    def test_set_bytes_uploaded_accumulates_delta(self) -> None:
        """Successive byte_callback firings accumulate correctly."""
        job = UploadJob(job_id="x")
        fs = FileUploadState("f1", "/p/f1", 1000)
        job.files.append(fs)
        job.total_bytes_cached = 1000
        # Simulate four chunks
        job.set_bytes_uploaded(fs, 250)
        job.set_bytes_uploaded(fs, 500)
        job.set_bytes_uploaded(fs, 750)
        job.set_bytes_uploaded(fs, 1000)
        assert fs.bytes_uploaded == 1000
        assert job.total_uploaded_bytes == 1000
        # Idempotent — no change on no-op
        job.set_bytes_uploaded(fs, 1000)
        assert job.total_uploaded_bytes == 1000

    def test_to_progress_dict_uses_cumulative_counters(self) -> None:
        """to_progress_dict reflects the cumulative counters (not an O(N) scan)."""
        job = UploadJob(job_id="x")
        for i in range(20):
            job.files.append(FileUploadState(f"f{i}", f"/p/f{i}", 100))
        job.total_bytes_cached = 2000
        for i in range(8):
            job.set_file_status(job.files[i], UploadStatus.COMPLETED)
            job.set_bytes_uploaded(job.files[i], 100)
        # Two active files (so we exercise the cap-8 break)
        for i in range(8, 10):
            job.set_file_status(job.files[i], UploadStatus.UPLOADING)

        d = job.to_progress_dict()
        assert d["files_completed"] == 8
        assert d["files_uploaded"] == 8
        assert d["total_files"] == 20
        assert d["progress_percent"] == 40.0
        # active_files reflects in-progress only, no terminal rows leaked in
        assert len(d["files"]) == 2

    def test_active_files_capped_at_eight(self) -> None:
        """When more than 8 files are active, only 8 appear in the progress dict."""
        job = UploadJob(job_id="x")
        for i in range(20):
            fs = FileUploadState(f"f{i}", f"/p/f{i}", 100)
            job.files.append(fs)
            job.set_file_status(fs, UploadStatus.UPLOADING)
        d = job.to_progress_dict()
        assert len(d["files"]) == 8


class TestUploadManager:
    """Tests for UploadManager class."""

    def test_create_job(self, temp_files: list[Path]) -> None:
        """Test job creation."""
        manager = UploadManager()
        file_paths = [str(f) for f in temp_files]

        job = manager.create_job(file_paths)

        assert job.job_id is not None
        assert len(job.files) == len(temp_files)
        assert job.status == UploadStatus.PENDING

    def test_create_job_skips_missing_files(self) -> None:
        """Test that missing files are skipped during job creation."""
        manager = UploadManager()
        file_paths = ["/nonexistent/file1.mcap", "/nonexistent/file2.mcap"]

        job = manager.create_job(file_paths)

        assert len(job.files) == 0

    def test_get_job(self, temp_files: list[Path]) -> None:
        """Test retrieving a job by ID."""
        manager = UploadManager()
        created_job = manager.create_job([str(temp_files[0])])

        retrieved_job = manager.get_job(created_job.job_id)

        assert retrieved_job is not None
        assert retrieved_job.job_id == created_job.job_id

    def test_get_job_not_found(self) -> None:
        """Test retrieving a nonexistent job."""
        manager = UploadManager()
        result = manager.get_job("nonexistent-id")
        assert result is None

    def test_cancel_job(self, temp_files: list[Path]) -> None:
        """Test cancelling a job."""
        manager = UploadManager()
        job = manager.create_job([str(temp_files[0])])

        result = manager.cancel_job(job.job_id)

        assert result is True
        assert job.cancelled is True

    def test_cancel_job_not_found(self) -> None:
        """Test cancelling a nonexistent job."""
        manager = UploadManager()
        result = manager.cancel_job("nonexistent-id")
        assert result is False

    def test_cleanup_old_jobs(self, temp_files: list[Path]) -> None:
        """Test cleanup of old completed jobs."""
        manager = UploadManager()
        job = manager.create_job([str(temp_files[0])])
        job.status = UploadStatus.COMPLETED
        job.completed_at = datetime(2020, 1, 1, tzinfo=UTC)  # Old date

        removed = manager.cleanup_old_jobs(max_age_seconds=1)

        assert removed == 1
        assert manager.get_job(job.job_id) is None

    @patch("app.services.upload_manager.s3_service")
    @patch("app.services.upload_manager.file_service")
    def test_analyze_job(
        self,
        mock_file_service: MagicMock,
        mock_s3: MagicMock,
        temp_files: list[Path],
    ) -> None:
        """Test job analysis."""
        # Setup mocks
        mock_s3.create_s3_client.return_value = MagicMock()
        mock_s3.check_file_exists.return_value = False
        mock_file_service.extract_timestamp.return_value = datetime(2024, 6, 15, 14, 30, 0)
        mock_file_service.generate_s3_key.return_value = (
            "data/year=2024/month=06/day=15/hour=14/minute=30/test.mcap"
        )

        manager = UploadManager()
        job = manager.create_job([str(temp_files[0])])

        result = manager.analyze_job(job.job_id, "profile", "us-west-2", "bucket")

        assert result is not None
        assert result.files[0].status == UploadStatus.READY
        assert result.files[0].s3_path != ""


class TestGetUploadManager:
    """Tests for get_upload_manager function."""

    def test_returns_singleton(self) -> None:
        """Test that get_upload_manager returns the same instance."""
        manager1 = get_upload_manager()
        manager2 = get_upload_manager()

        assert manager1 is manager2

    def test_returns_upload_manager_instance(self) -> None:
        """Test that get_upload_manager returns an UploadManager."""
        manager = get_upload_manager()
        assert isinstance(manager, UploadManager)
