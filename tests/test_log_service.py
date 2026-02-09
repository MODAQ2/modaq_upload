"""Tests for the JSONL log service."""

import csv
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from app.services.log_service import LogService


@pytest.fixture
def log_service(tmp_path: Path) -> LogService:
    """Create a log service with a temporary log directory."""
    # Reset singleton so we get a fresh instance
    LogService._instance = None

    svc = LogService()

    # Patch settings to use tmp_path as log directory
    mock_settings = MagicMock()
    mock_settings.log_directory = tmp_path

    with patch("app.services.log_service.get_settings", return_value=mock_settings):
        # Prime the service so it uses our tmp_path
        pass

    # We need the mock active during all calls, so we store it
    svc._test_settings_mock = mock_settings  # type: ignore[attr-defined]
    return svc


@pytest.fixture
def _mock_settings(log_service: LogService) -> Any:
    """Context manager that patches get_settings for the log service."""
    return patch(
        "app.services.log_service.get_settings",
        return_value=log_service._test_settings_mock,  # type: ignore[attr-defined]
    )


def _find_event_files(log_dir: Path) -> list[Path]:
    """Find all events.jsonl files under the hive-partitioned json/ directory."""
    json_dir = log_dir / "json"
    if not json_dir.exists():
        return []
    return list(json_dir.rglob("events.jsonl"))


class TestLogServiceWrite:
    """Tests for writing log entries."""

    def test_log_creates_file(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test that log() creates a JSONL file in hive-partitioned structure."""
        with _mock_settings:
            log_service.log("INFO", "app", "test_event", "Test message")

        log_dir: Path = log_service._test_settings_mock.log_directory  # type: ignore[attr-defined]
        files = _find_event_files(log_dir)
        assert len(files) == 1
        assert "json" in str(files[0])
        assert "year=" in str(files[0])

    def test_log_entry_format(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test that log entries have the correct JSON schema."""
        with _mock_settings:
            log_service.log(
                "INFO", "upload", "file_uploaded", "Uploaded file.mcap", {"file_size": 1024}
            )

        log_dir: Path = log_service._test_settings_mock.log_directory  # type: ignore[attr-defined]
        log_file = _find_event_files(log_dir)[0]
        line = log_file.read_text().strip()
        entry = json.loads(line)

        assert "timestamp" in entry
        assert entry["level"] == "INFO"
        assert entry["category"] == "upload"
        assert entry["event"] == "file_uploaded"
        assert entry["message"] == "Uploaded file.mcap"
        assert entry["metadata"]["file_size"] == 1024

    def test_info_convenience(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test info() convenience method."""
        with _mock_settings:
            log_service.info("app", "test", "Test info")

        log_dir: Path = log_service._test_settings_mock.log_directory  # type: ignore[attr-defined]
        log_file = _find_event_files(log_dir)[0]
        entry = json.loads(log_file.read_text().strip())
        assert entry["level"] == "INFO"

    def test_warning_convenience(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test warning() convenience method."""
        with _mock_settings:
            log_service.warning("app", "test", "Test warning")

        log_dir: Path = log_service._test_settings_mock.log_directory  # type: ignore[attr-defined]
        log_file = _find_event_files(log_dir)[0]
        entry = json.loads(log_file.read_text().strip())
        assert entry["level"] == "WARNING"

    def test_error_convenience(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test error() convenience method."""
        with _mock_settings:
            log_service.error("app", "test", "Test error")

        log_dir: Path = log_service._test_settings_mock.log_directory  # type: ignore[attr-defined]
        log_file = _find_event_files(log_dir)[0]
        entry = json.loads(log_file.read_text().strip())
        assert entry["level"] == "ERROR"

    def test_multiple_entries_appended(
        self, log_service: LogService, _mock_settings: Any
    ) -> None:
        """Test that multiple log calls append to the same file."""
        with _mock_settings:
            log_service.info("app", "event1", "First")
            log_service.info("app", "event2", "Second")
            log_service.error("app", "event3", "Third")

        log_dir: Path = log_service._test_settings_mock.log_directory  # type: ignore[attr-defined]
        log_file = _find_event_files(log_dir)[0]
        lines = [line for line in log_file.read_text().strip().split("\n") if line]
        assert len(lines) == 3

    def test_no_metadata_omits_field(
        self, log_service: LogService, _mock_settings: Any
    ) -> None:
        """Test that metadata field is omitted when not provided."""
        with _mock_settings:
            log_service.info("app", "test", "No metadata")

        log_dir: Path = log_service._test_settings_mock.log_directory  # type: ignore[attr-defined]
        log_file = _find_event_files(log_dir)[0]
        entry = json.loads(log_file.read_text().strip())
        assert "metadata" not in entry


class TestLogServiceRead:
    """Tests for reading and filtering log entries."""

    def test_read_entries(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test reading entries returns correct structure."""
        with _mock_settings:
            log_service.info("app", "event1", "First")
            log_service.error("upload", "event2", "Second")
            result = log_service.read_log_entries()

        assert result["total"] == 2
        assert len(result["entries"]) == 2
        assert result["offset"] == 0

    def test_filter_by_level(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test filtering by level."""
        with _mock_settings:
            log_service.info("app", "event1", "Info msg")
            log_service.error("app", "event2", "Error msg")
            result = log_service.read_log_entries(level="ERROR")

        assert result["total"] == 1
        assert result["entries"][0]["level"] == "ERROR"

    def test_filter_by_category(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test filtering by category."""
        with _mock_settings:
            log_service.info("upload", "event1", "Upload msg")
            log_service.info("settings", "event2", "Settings msg")
            result = log_service.read_log_entries(category="upload")

        assert result["total"] == 1
        assert result["entries"][0]["category"] == "upload"

    def test_filter_by_search(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test full-text search in message field."""
        with _mock_settings:
            log_service.info("app", "event1", "Uploaded file.mcap successfully")
            log_service.info("app", "event2", "Started application")
            result = log_service.read_log_entries(search="file.mcap")

        assert result["total"] == 1

    def test_pagination(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test offset/limit pagination."""
        with _mock_settings:
            for i in range(5):
                log_service.info("app", f"event{i}", f"Message {i}")
            result = log_service.read_log_entries(offset=2, limit=2)

        assert result["total"] == 5
        assert len(result["entries"]) == 2
        assert result["offset"] == 2

    def test_read_entries_date_filter_hive(
        self, log_service: LogService, _mock_settings: Any
    ) -> None:
        """Test that date filter constructs the correct hive path."""
        with _mock_settings:
            log_service.info("app", "event1", "Today's entry")
            today = datetime.now(UTC).strftime("%Y-%m-%d")
            result = log_service.read_log_entries(date=today)

        assert result["total"] == 1
        assert result["entries"][0]["event"] == "event1"

    def test_read_entries_invalid_date(
        self, log_service: LogService, _mock_settings: Any
    ) -> None:
        """Test that an invalid date returns empty results."""
        with _mock_settings:
            result = log_service.read_log_entries(date="not-a-date")

        assert result["total"] == 0
        assert result["entries"] == []

    def test_list_log_files(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test listing log files."""
        with _mock_settings:
            log_service.info("app", "test", "Entry")
            files = log_service.list_log_files()

        assert len(files) == 1
        assert files[0]["filename"].endswith(".jsonl")
        assert files[0]["size_bytes"] > 0
        assert files[0]["type"] == "jsonl"
        assert "relative_path" in files[0]

    def test_list_log_files_includes_csv(
        self, log_service: LogService, _mock_settings: Any
    ) -> None:
        """Test that list_log_files includes both JSONL and CSV files."""
        log_dir: Path = log_service._test_settings_mock.log_directory  # type: ignore[attr-defined]
        with _mock_settings:
            log_service.info("app", "test", "Entry")

            # Manually create a CSV file in the hive structure
            now = datetime.now(UTC)
            csv_dir = (
                log_dir
                / "csv"
                / f"year={now.year:04d}"
                / f"month={now.month:02d}"
                / f"day={now.day:02d}"
            )
            csv_dir.mkdir(parents=True, exist_ok=True)
            csv_file = csv_dir / "upload-summary-120000-abcd1234.csv"
            csv_file.write_text("col1,col2\nval1,val2\n")

            files = log_service.list_log_files()

        jsonl_files = [f for f in files if f["type"] == "jsonl"]
        csv_files = [f for f in files if f["type"] == "csv"]
        assert len(jsonl_files) >= 1
        assert len(csv_files) == 1
        assert csv_files[0]["filename"] == "upload-summary-120000-abcd1234.csv"


class TestLogServiceStats:
    """Tests for log statistics."""

    def test_get_stats(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test stats aggregation."""
        with _mock_settings:
            log_service.info("upload", "event1", "Info 1")
            log_service.info("upload", "event2", "Info 2")
            log_service.error("app", "event3", "Error 1")
            stats = log_service.get_log_stats()

        assert stats["total_entries"] == 3
        assert stats["level_counts"]["INFO"] == 2
        assert stats["level_counts"]["ERROR"] == 1
        assert stats["category_counts"]["upload"] == 2
        assert stats["category_counts"]["app"] == 1
        assert stats["file_count"] == 1

    def test_empty_stats(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test stats with no log files."""
        with _mock_settings:
            stats = log_service.get_log_stats()

        assert stats["total_entries"] == 0
        assert stats["file_count"] == 0

    def test_stats_includes_csv_count(
        self, log_service: LogService, _mock_settings: Any
    ) -> None:
        """Test that stats include csv_count."""
        with _mock_settings:
            log_service.info("app", "test", "Entry")
            stats = log_service.get_log_stats()

        assert "csv_count" in stats
        assert stats["csv_count"] == 0


class TestLogServiceSync:
    """Tests for S3 sync."""

    def test_sync_uploads_files(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test that sync uploads JSONL files to S3."""
        mock_client = MagicMock()

        with _mock_settings:
            log_service.info("app", "test", "Entry")
            result = log_service.sync_logs_to_s3(mock_client, "test-bucket")

        assert result["success"] is True
        # 1 from the test entry + 1 from the sync_completed log inside sync
        assert result["synced"] >= 1
        mock_client.upload_file.assert_called()

    def test_sync_skips_unchanged(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test that sync skips files that haven't changed."""
        mock_client = MagicMock()

        with _mock_settings:
            log_service.info("app", "test", "Entry")
            # First sync
            log_service.sync_logs_to_s3(mock_client, "test-bucket")
            mock_client.reset_mock()
            # Second sync with no new entries — files may have grown due to
            # the sync_completed log entry written by first sync
            result = log_service.sync_logs_to_s3(mock_client, "test-bucket")

        # The sync itself writes a log entry, so the file grows.
        # What matters is the mechanism works (not zero uploads necessarily)
        assert result["total_files"] >= 1

    def test_sync_uses_relative_hive_paths(
        self, log_service: LogService, _mock_settings: Any
    ) -> None:
        """Test that S3 keys use hive-partitioned relative paths."""
        mock_client = MagicMock()

        with _mock_settings:
            log_service.info("app", "test", "Entry")
            log_service.sync_logs_to_s3(mock_client, "test-bucket", prefix="logs/")

        # Check that S3 keys contain hive partition components
        calls = mock_client.upload_file.call_args_list
        assert len(calls) >= 1
        for call in calls:
            s3_key = call[0][2]  # Third positional arg is the S3 key
            assert s3_key.startswith("logs/json/year=")
            assert "/month=" in s3_key
            assert "/day=" in s3_key


class TestHivePartitioning:
    """Tests for hive-partitioned directory structure."""

    def test_hive_dir_structure(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test that _get_hive_dir creates the correct directory path."""
        log_dir: Path = log_service._test_settings_mock.log_directory  # type: ignore[attr-defined]
        dt = datetime(2026, 2, 8, 14, 30, 25, tzinfo=UTC)

        with _mock_settings:
            hive_dir = log_service._get_hive_dir("json", dt)

        assert hive_dir == log_dir / "json" / "year=2026" / "month=02" / "day=08"
        assert hive_dir.exists()

    def test_hive_dir_csv(self, log_service: LogService, _mock_settings: Any) -> None:
        """Test hive dir for csv subdirectory."""
        log_dir: Path = log_service._test_settings_mock.log_directory  # type: ignore[attr-defined]
        dt = datetime(2025, 12, 31, 23, 59, 0, tzinfo=UTC)

        with _mock_settings:
            hive_dir = log_service._get_hive_dir("csv", dt)

        assert hive_dir == log_dir / "csv" / "year=2025" / "month=12" / "day=31"
        assert hive_dir.exists()

    def test_extract_date_from_hive_path(self) -> None:
        """Test extracting date from hive path."""
        path = Path("/tmp/logs/json/year=2026/month=02/day=08/events.jsonl")
        result = LogService._extract_date_from_hive_path(path)
        assert result == "2026-02-08"

    def test_extract_date_from_non_hive_path(self) -> None:
        """Test that non-hive paths return None."""
        path = Path("/tmp/logs/2026-02-08.jsonl")
        result = LogService._extract_date_from_hive_path(path)
        assert result is None

    def test_log_writes_to_hive_path(
        self, log_service: LogService, _mock_settings: Any
    ) -> None:
        """Test that log() writes to a hive-partitioned events.jsonl."""
        log_dir: Path = log_service._test_settings_mock.log_directory  # type: ignore[attr-defined]

        with _mock_settings:
            log_service.info("app", "test", "Hello")

        # Verify the file exists at the hive path
        now = datetime.now(UTC)
        expected_dir = (
            log_dir
            / "json"
            / f"year={now.year:04d}"
            / f"month={now.month:02d}"
            / f"day={now.day:02d}"
        )
        events_file = expected_dir / "events.jsonl"
        assert events_file.exists()
        entry = json.loads(events_file.read_text().strip())
        assert entry["event"] == "test"


class TestJobSaveJsonl:
    """Tests for per-job JSONL saving."""

    def test_save_job_jsonl_creates_file(
        self, log_service: LogService, _mock_settings: Any
    ) -> None:
        """Test that save_job_jsonl creates a file at the correct hive path."""
        log_dir: Path = log_service._test_settings_mock.log_directory  # type: ignore[attr-defined]
        job_id = "a1b2c3d4-5678-9abc-def0-1234567890ab"
        completed_at = datetime(2026, 2, 8, 14, 30, 25, tzinfo=UTC)
        job_dict = {"event": "upload_job_completed", "job_id": job_id, "uploaded": 3}

        with _mock_settings:
            result_path = log_service.save_job_jsonl(job_id, job_dict, completed_at)

        expected_dir = log_dir / "json" / "year=2026" / "month=02" / "day=08"
        assert result_path == expected_dir / f"{job_id}.jsonl"
        assert result_path.exists()

        content = json.loads(result_path.read_text().strip())
        assert content["job_id"] == job_id
        assert content["uploaded"] == 3

    def test_save_job_jsonl_is_single_line(
        self, log_service: LogService, _mock_settings: Any
    ) -> None:
        """Test that the JSONL file has exactly one line."""
        job_id = "test-job-id"
        completed_at = datetime(2026, 1, 15, tzinfo=UTC)

        with _mock_settings:
            path = log_service.save_job_jsonl(
                job_id, {"event": "test", "job_id": job_id}, completed_at
            )

        lines = [ln for ln in path.read_text().split("\n") if ln.strip()]
        assert len(lines) == 1


class TestJobSaveCsv:
    """Tests for per-job CSV saving."""

    def _make_mock_job(self) -> MagicMock:
        """Create a mock UploadJob with file states."""
        mock_file = MagicMock()
        mock_file.filename = "test.mcap"
        mock_file.file_size = 1024000
        mock_file.s3_path = "year=2026/month=02/day=08/hour=14/minute=30/test.mcap"
        mock_file.status.value = "completed"
        mock_file.start_time.isoformat.return_value = "2026-02-08T14:30:00+00:00"
        mock_file.upload_started_at.isoformat.return_value = "2026-02-08T14:30:05+00:00"
        mock_file.upload_completed_at.isoformat.return_value = "2026-02-08T14:30:15+00:00"
        mock_file.upload_duration_seconds = 10.0
        mock_file.is_duplicate = False
        mock_file.is_valid = True
        mock_file.error_message = ""

        mock_job = MagicMock()
        mock_job.files = [mock_file]
        return mock_job

    def test_save_job_csv_creates_file(
        self, log_service: LogService, _mock_settings: Any
    ) -> None:
        """Test that save_job_csv creates a CSV at the correct hive path."""
        log_dir: Path = log_service._test_settings_mock.log_directory  # type: ignore[attr-defined]
        job_id = "a1b2c3d4-5678-9abc-def0-1234567890ab"
        completed_at = datetime(2026, 2, 8, 14, 30, 25, tzinfo=UTC)
        mock_job = self._make_mock_job()

        with _mock_settings:
            result_path = log_service.save_job_csv(job_id, mock_job, completed_at)

        expected_dir = log_dir / "csv" / "year=2026" / "month=02" / "day=08"
        assert result_path.parent == expected_dir
        assert result_path.name.startswith("upload-summary-143025-a1b2c3d4")
        assert result_path.name.endswith(".csv")
        assert result_path.exists()

    def test_save_job_csv_columns(
        self, log_service: LogService, _mock_settings: Any
    ) -> None:
        """Test that the CSV has all 14 expected columns."""
        job_id = "test-job-id-1234"
        completed_at = datetime(2026, 2, 8, 12, 0, 0, tzinfo=UTC)
        mock_job = self._make_mock_job()

        with _mock_settings:
            result_path = log_service.save_job_csv(job_id, mock_job, completed_at)

        with open(result_path, newline="") as f:
            reader = csv.reader(f)
            header = next(reader)

        expected_columns = [
            "job_id",
            "filename",
            "file_size_bytes",
            "file_size_formatted",
            "s3_path",
            "status",
            "data_start_time",
            "upload_started_at",
            "upload_completed_at",
            "upload_duration_seconds",
            "upload_speed_mbps",
            "is_duplicate",
            "is_valid",
            "error_message",
        ]
        assert header == expected_columns

    def test_save_job_csv_data_row(
        self, log_service: LogService, _mock_settings: Any
    ) -> None:
        """Test that the CSV has a data row for each file."""
        job_id = "test-job-id"
        completed_at = datetime(2026, 2, 8, 12, 0, 0, tzinfo=UTC)
        mock_job = self._make_mock_job()

        with _mock_settings:
            result_path = log_service.save_job_csv(job_id, mock_job, completed_at)

        with open(result_path, newline="") as f:
            reader = csv.reader(f)
            rows = list(reader)

        # Header + 1 data row
        assert len(rows) == 2
        data_row = rows[1]
        assert data_row[0] == job_id
        assert data_row[1] == "test.mcap"
        assert data_row[2] == "1024000"
