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
        """Test uploaded_bytes property."""
        job = UploadJob(job_id="test-job")
        job.files = [
            FileUploadState("f1.mcap", "/p/f1.mcap", 1000),
            FileUploadState("f2.mcap", "/p/f2.mcap", 2000),
        ]
        job.files[0].bytes_uploaded = 500
        job.files[1].bytes_uploaded = 1000

        assert job.uploaded_bytes == 1500

    def test_progress_percent(self) -> None:
        """Test progress_percent property."""
        job = UploadJob(job_id="test-job")
        job.files = [
            FileUploadState("f1.mcap", "/p/f1.mcap", 1000),
            FileUploadState("f2.mcap", "/p/f2.mcap", 1000),
        ]
        job.files[0].bytes_uploaded = 1000
        job.files[1].bytes_uploaded = 500

        assert job.progress_percent == 75.0

    def test_progress_percent_empty(self) -> None:
        """Test progress_percent with no files."""
        job = UploadJob(job_id="test-job")
        assert job.progress_percent == 0.0

    def test_files_completed(self) -> None:
        """Test files_completed property."""
        job = UploadJob(job_id="test-job")
        job.files = [
            FileUploadState("f1.mcap", "/p/f1.mcap", 1000),
            FileUploadState("f2.mcap", "/p/f2.mcap", 1000),
            FileUploadState("f3.mcap", "/p/f3.mcap", 1000),
        ]
        job.files[0].status = UploadStatus.COMPLETED
        job.files[1].status = UploadStatus.SKIPPED
        job.files[2].status = UploadStatus.UPLOADING

        assert job.files_completed == 2

    def test_files_failed(self) -> None:
        """Test files_failed property."""
        job = UploadJob(job_id="test-job")
        job.files = [
            FileUploadState("f1.mcap", "/p/f1.mcap", 1000),
            FileUploadState("f2.mcap", "/p/f2.mcap", 1000),
        ]
        job.files[0].status = UploadStatus.FAILED
        job.files[1].status = UploadStatus.COMPLETED

        assert job.files_failed == 1

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
    @patch("app.services.upload_manager.mcap_service")
    def test_analyze_job(
        self,
        mock_mcap: MagicMock,
        mock_s3: MagicMock,
        temp_files: list[Path],
    ) -> None:
        """Test job analysis."""
        # Setup mocks
        mock_s3.create_s3_client.return_value = MagicMock()
        mock_s3.check_file_exists.return_value = False
        mock_mcap.extract_start_time.return_value = datetime(2024, 6, 15, 14, 30, 0)
        mock_mcap.generate_s3_path.return_value = (
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
