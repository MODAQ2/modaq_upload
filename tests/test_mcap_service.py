"""Tests for the MCAP service module."""

from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.services import mcap_service
from app.services.mcap_service import _extract_timestamp_from_filename


class TestGenerateS3Path:
    """Tests for generate_s3_path function."""

    def test_basic_path_generation(self) -> None:
        """Test basic S3 path generation."""
        timestamp = datetime(2024, 6, 15, 14, 35, 0)
        result = mcap_service.generate_s3_path(timestamp, "test.mcap")

        assert result == "data/year=2024/month=06/day=15/hour=14/minute=30/test.mcap"

    def test_10min_bucket_rounding(self, sample_timestamps: list[tuple[int, int, str]]) -> None:
        """Test that minutes are correctly rounded to 10-minute buckets."""
        for minute, expected_bucket, description in sample_timestamps:
            timestamp = datetime(2024, 1, 1, 12, minute, 0)
            result = mcap_service.generate_s3_path(timestamp, "test.mcap")

            assert f"minute={expected_bucket:02d}" in result, f"Failed for: {description}"

    def test_zero_padded_values(self) -> None:
        """Test that single-digit values are zero-padded."""
        timestamp = datetime(2024, 1, 5, 3, 7, 0)
        result = mcap_service.generate_s3_path(timestamp, "test.mcap")

        assert "month=01" in result
        assert "day=05" in result
        assert "hour=03" in result
        assert "minute=00" in result

    def test_preserves_filename(self) -> None:
        """Test that the original filename is preserved."""
        timestamp = datetime(2024, 6, 15, 14, 0, 0)
        filename = "my_data_file_2024.mcap"
        result = mcap_service.generate_s3_path(timestamp, filename)

        assert result.endswith(filename)

    def test_end_of_year(self) -> None:
        """Test path generation at end of year."""
        timestamp = datetime(2024, 12, 31, 23, 59, 59)
        result = mcap_service.generate_s3_path(timestamp, "test.mcap")

        assert "year=2024" in result
        assert "month=12" in result
        assert "day=31" in result
        assert "hour=23" in result
        assert "minute=50" in result


class TestExtractStartTime:
    """Tests for extract_start_time function."""

    def test_file_not_found(self) -> None:
        """Test that FileNotFoundError is raised for missing files."""
        with pytest.raises(FileNotFoundError):
            mcap_service.extract_start_time("/nonexistent/path/file.mcap")

    def test_invalid_mcap_raises_value_error(self, temp_mcap_file: Path) -> None:
        """Test that invalid MCAP files raise ValueError."""
        # The temp file is not a valid MCAP, so it should raise an error
        with pytest.raises((ValueError, ImportError)):
            mcap_service.extract_start_time(temp_mcap_file)

    @patch("modaq_toolkit.MCAPParser")
    def test_successful_extraction(self, mock_parser_class: MagicMock) -> None:
        """Test successful timestamp extraction with mocked parser."""
        import pandas as pd

        # Setup mock
        mock_parser = MagicMock()
        mock_parser_class.return_value = mock_parser

        # Create a real pandas DataFrame with datetime index
        test_time = datetime(2024, 6, 15, 14, 30, 0)
        mock_df = pd.DataFrame({"value": [1, 2, 3]}, index=pd.to_datetime([test_time] * 3))
        mock_parser.get_dataframes.return_value = {"topic1": mock_df}

        # Create a temp file path that "exists"
        with patch("pathlib.Path.exists", return_value=True):
            result = mcap_service.extract_start_time("/fake/path.mcap")

        assert result == test_time

    @patch("modaq_toolkit.MCAPParser")
    def test_no_channels_falls_back_to_filename(self, mock_parser_class: MagicMock) -> None:
        """Test that empty topic list falls back to filename parsing."""
        mock_parser = MagicMock()
        mock_parser_class.return_value = mock_parser
        mock_parser.get_dataframes.return_value = {}

        # Use a filename with embedded timestamp
        with patch("pathlib.Path.exists", return_value=True):
            with patch.object(Path, "name", "Bag_2024_06_15_14_30_00.mcap"):
                result = mcap_service.extract_start_time("/fake/Bag_2024_06_15_14_30_00.mcap")

        assert result == datetime(2024, 6, 15, 14, 30, 0)

    @patch("modaq_toolkit.MCAPParser")
    def test_no_channels_no_filename_timestamp_raises_error(
        self, mock_parser_class: MagicMock
    ) -> None:
        """Test that error is raised when no timestamp can be found."""
        mock_parser = MagicMock()
        mock_parser_class.return_value = mock_parser
        mock_parser.get_dataframes.return_value = {}

        with patch("pathlib.Path.exists", return_value=True):
            with patch.object(Path, "name", "random_file.mcap"):
                with pytest.raises(ValueError, match="Could not extract timestamps"):
                    mcap_service.extract_start_time("/fake/random_file.mcap")


class TestGetFileInfo:
    """Tests for get_file_info function."""

    def test_nonexistent_file(self) -> None:
        """Test handling of nonexistent files."""
        result = mcap_service.get_file_info("/nonexistent/file.mcap")

        assert result["filename"] == "file.mcap"
        assert result["error"] is not None

    def test_file_info_structure(self, temp_mcap_file: Path) -> None:
        """Test that file info returns expected structure."""
        result = mcap_service.get_file_info(temp_mcap_file)

        assert "filename" in result
        assert "path" in result
        assert "size" in result
        assert "start_time" in result
        assert "s3_path" in result
        assert "error" in result

        assert result["filename"] == temp_mcap_file.name
        assert result["size"] > 0


class TestExtractTimestampFromFilename:
    """Tests for _extract_timestamp_from_filename function."""

    def test_bag_underscore_format(self) -> None:
        """Test Bag_YYYY_MM_DD_HH_mm_ss format."""
        result = _extract_timestamp_from_filename("Bag_2026_01_22_17_10_46_0.mcap")
        assert result == datetime(2026, 1, 22, 17, 10, 46)

    def test_bag_format_with_suffix(self) -> None:
        """Test Bag format with various suffixes."""
        result = _extract_timestamp_from_filename("Bag_2024_06_15_14_30_00_1.mcap")
        assert result == datetime(2024, 6, 15, 14, 30, 0)

    def test_iso_dash_format(self) -> None:
        """Test YYYY-MM-DD_HH-mm-ss format."""
        result = _extract_timestamp_from_filename("recording_2024-06-15_14-30-00.mcap")
        assert result == datetime(2024, 6, 15, 14, 30, 0)

    def test_compact_format(self) -> None:
        """Test YYYYMMDD_HHmmss format."""
        result = _extract_timestamp_from_filename("data_20240615_143000.mcap")
        assert result == datetime(2024, 6, 15, 14, 30, 0)

    def test_no_timestamp_returns_none(self) -> None:
        """Test that filenames without timestamps return None."""
        assert _extract_timestamp_from_filename("random_file.mcap") is None
        assert _extract_timestamp_from_filename("test.mcap") is None

    def test_invalid_date_returns_none(self) -> None:
        """Test that invalid dates return None."""
        # Invalid month (13)
        assert _extract_timestamp_from_filename("Bag_2024_13_15_14_30_00.mcap") is None


class TestFormatFileSize:
    """Tests for format_file_size function."""

    def test_bytes(self) -> None:
        """Test formatting bytes."""
        assert mcap_service.format_file_size(0) == "0.0 B"
        assert mcap_service.format_file_size(500) == "500.0 B"

    def test_kilobytes(self) -> None:
        """Test formatting kilobytes."""
        assert mcap_service.format_file_size(1024) == "1.0 KB"
        assert mcap_service.format_file_size(1536) == "1.5 KB"

    def test_megabytes(self) -> None:
        """Test formatting megabytes."""
        assert mcap_service.format_file_size(1024 * 1024) == "1.0 MB"
        assert mcap_service.format_file_size(int(1024 * 1024 * 2.5)) == "2.5 MB"

    def test_gigabytes(self) -> None:
        """Test formatting gigabytes."""
        assert mcap_service.format_file_size(1024**3) == "1.0 GB"

    def test_terabytes(self) -> None:
        """Test formatting terabytes."""
        assert mcap_service.format_file_size(1024**4) == "1.0 TB"
