"""Tests for the S3 service module."""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Import moto for AWS mocking
try:
    import boto3
    from moto import mock_aws

    MOTO_AVAILABLE = True
except ImportError:
    MOTO_AVAILABLE = False
    mock_aws = None  # type: ignore[assignment]

from app.services import s3_service


class TestGetAvailableProfiles:
    """Tests for get_available_profiles function."""

    def test_always_includes_default(self) -> None:
        """Test that default profile is always included."""
        with patch("pathlib.Path.exists", return_value=False):
            profiles = s3_service.get_available_profiles()
            assert "default" in profiles

    @patch("configparser.ConfigParser.read")
    @patch("configparser.ConfigParser.sections")
    @patch("pathlib.Path.exists")
    def test_reads_credentials_file(
        self,
        mock_exists: MagicMock,
        mock_sections: MagicMock,
        mock_read: MagicMock,
    ) -> None:
        """Test that credentials file is read."""
        mock_exists.return_value = True
        mock_sections.return_value = ["profile1", "profile2"]

        profiles = s3_service.get_available_profiles()

        assert "profile1" in profiles
        assert "profile2" in profiles

    def test_returns_sorted_list(self) -> None:
        """Test that profiles are returned sorted."""
        with patch("pathlib.Path.exists", return_value=False):
            profiles = s3_service.get_available_profiles()
            assert profiles == sorted(profiles)


@pytest.mark.skipif(not MOTO_AVAILABLE, reason="moto not installed")
class TestS3Operations:
    """Tests for S3 operations using moto mock."""

    def test_check_file_exists_true(self) -> None:
        """Test check_file_exists returns True for existing file."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )
            client.put_object(Bucket="test-bucket", Key="test/file.mcap", Body=b"data")

            result = s3_service.check_file_exists(client, "test-bucket", "test/file.mcap")
            assert result is True

    def test_check_file_exists_false(self) -> None:
        """Test check_file_exists returns False for missing file."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )

            result = s3_service.check_file_exists(client, "test-bucket", "nonexistent/file.mcap")
            assert result is False

    def test_list_bucket_objects_empty(self) -> None:
        """Test listing objects in an empty bucket."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )

            result = s3_service.list_bucket_objects(client, "test-bucket")

            assert result["success"] is True
            assert result["folders"] == []
            assert result["files"] == []

    def test_list_bucket_objects_with_files(self) -> None:
        """Test listing objects with files and folders."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )
            client.put_object(Bucket="test-bucket", Key="folder1/file1.mcap", Body=b"data")
            client.put_object(Bucket="test-bucket", Key="folder1/file2.mcap", Body=b"data")
            client.put_object(Bucket="test-bucket", Key="folder2/file3.mcap", Body=b"data")

            result = s3_service.list_bucket_objects(client, "test-bucket")

            assert result["success"] is True
            assert len(result["folders"]) == 2
            folder_names = [f["name"] for f in result["folders"]]
            assert "folder1" in folder_names
            assert "folder2" in folder_names

    def test_list_bucket_objects_with_prefix(self) -> None:
        """Test listing objects with a prefix filter."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )
            client.put_object(Bucket="test-bucket", Key="folder1/sub/file1.mcap", Body=b"data")
            client.put_object(Bucket="test-bucket", Key="folder1/file2.mcap", Body=b"data")

            result = s3_service.list_bucket_objects(client, "test-bucket", prefix="folder1/")

            assert result["success"] is True
            assert result["prefix"] == "folder1/"

    def test_validate_bucket_access_success(self) -> None:
        """Test validate_bucket_access for accessible bucket."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )

            result = s3_service.validate_bucket_access(client, "test-bucket")

            assert result["success"] is True
            assert result["error"] is None

    def test_validate_bucket_access_not_found(self) -> None:
        """Test validate_bucket_access for nonexistent bucket."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")

            result = s3_service.validate_bucket_access(client, "nonexistent-bucket")

            assert result["success"] is False
            assert result["error"] is not None

    def test_upload_file_with_progress(self, temp_mcap_file: Path) -> None:
        """Test uploading a file with progress callback."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )

            progress_calls: list[tuple[int, int]] = []

            def callback(uploaded: int, total: int) -> None:
                progress_calls.append((uploaded, total))

            result = s3_service.upload_file_with_progress(
                client,
                str(temp_mcap_file),
                "test-bucket",
                "test/upload.mcap",
                callback,
            )

            assert result["success"] is True
            assert result["key"] == "test/upload.mcap"

    def test_get_object_metadata(self) -> None:
        """Test getting object metadata."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )
            client.put_object(Bucket="test-bucket", Key="test/file.mcap", Body=b"test data")

            result = s3_service.get_object_metadata(client, "test-bucket", "test/file.mcap")

            assert result["success"] is True
            assert result["size"] == 9  # len("test data")


class TestCreateS3Client:
    """Tests for create_s3_client function."""

    @patch("boto3.Session")
    def test_creates_session_with_profile(self, mock_session: MagicMock) -> None:
        """Test that session is created with correct profile."""
        mock_client = MagicMock()
        mock_session.return_value.client.return_value = mock_client

        s3_service.create_s3_client("test-profile", "us-west-2")

        mock_session.assert_called_once_with(profile_name="test-profile", region_name="us-west-2")

    @patch("boto3.Session")
    def test_default_region(self, mock_session: MagicMock) -> None:
        """Test that default region is us-west-2."""
        mock_client = MagicMock()
        mock_session.return_value.client.return_value = mock_client

        s3_service.create_s3_client("test-profile")

        mock_session.assert_called_once_with(profile_name="test-profile", region_name="us-west-2")
