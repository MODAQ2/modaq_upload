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

    def test_list_bucket_objects_single_page(self) -> None:
        """A folder smaller than the page size returns no continuation token."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )
            for i in range(5):
                client.put_object(Bucket="test-bucket", Key=f"data/file{i}.mcap", Body=b"x")

            result = s3_service.list_bucket_objects(client, "test-bucket", prefix="data/")

            assert result["success"] is True
            assert len(result["files"]) == 5
            assert result["next_token"] is None

    def test_list_bucket_objects_pagination(self) -> None:
        """A folder larger than the page size paginates via next_token."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )
            for i in range(25):
                # Zero-pad so keys sort predictably across pages.
                client.put_object(Bucket="test-bucket", Key=f"data/file{i:03d}.mcap", Body=b"x")

            # First page: capped at max_keys, with a token for the rest.
            page1 = s3_service.list_bucket_objects(
                client, "test-bucket", prefix="data/", max_keys=10
            )
            assert page1["success"] is True
            assert len(page1["files"]) == 10
            assert page1["next_token"]

            # Second page resumes where the first left off.
            page2 = s3_service.list_bucket_objects(
                client,
                "test-bucket",
                prefix="data/",
                max_keys=10,
                continuation_token=page1["next_token"],
            )
            assert len(page2["files"]) == 10
            assert page2["next_token"]

            # Final page drains the remainder and clears the token.
            page3 = s3_service.list_bucket_objects(
                client,
                "test-bucket",
                prefix="data/",
                max_keys=10,
                continuation_token=page2["next_token"],
            )
            assert len(page3["files"]) == 5
            assert page3["next_token"] is None

            # All 25 distinct keys are covered with no overlap.
            keys = {f["key"] for f in page1["files"] + page2["files"] + page3["files"]}
            assert len(keys) == 25

    def test_get_prefix_counts(self) -> None:
        """Counts subfolders and direct files for the current level."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )
            # Two direct files plus two subfolders (each with nested files).
            client.put_object(Bucket="test-bucket", Key="root/a.mcap", Body=b"x")
            client.put_object(Bucket="test-bucket", Key="root/b.mcap", Body=b"x")
            client.put_object(Bucket="test-bucket", Key="root/sub1/c.mcap", Body=b"x")
            client.put_object(Bucket="test-bucket", Key="root/sub2/d.mcap", Body=b"x")

            result = s3_service.get_prefix_counts(client, "test-bucket", prefix="root/")

            assert result["success"] is True
            # Direct files only; nested files belong to the subfolders.
            assert result["file_count"] == 2
            assert result["folder_count"] == 2
            assert result["capped"] is False

    def test_get_prefix_counts_bounded_to_one_page(self) -> None:
        """A level larger than one page is bounded to a single call and capped."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )
            for i in range(1500):
                client.put_object(Bucket="test-bucket", Key=f"data/file{i:04d}.mcap", Body=b"x")

            result = s3_service.get_prefix_counts(client, "test-bucket", prefix="data/")

            assert result["success"] is True
            # One page only (no enumeration of all 1500): counts are a lower bound.
            assert result["capped"] is True
            assert result["file_count"] == 1000
            assert result["folder_count"] == 0

    def test_get_prefix_counts_caps_large_levels(self) -> None:
        """Counting stops at max_items and flags the result as capped."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )
            for i in range(60):
                client.put_object(Bucket="test-bucket", Key=f"data/file{i:04d}.mcap", Body=b"x")

            result = s3_service.get_prefix_counts(
                client, "test-bucket", prefix="data/", max_items=25
            )

            assert result["success"] is True
            assert result["file_count"] == 25
            assert result["capped"] is True

    def test_get_prefix_counts_caps_folder_heavy_levels(self) -> None:
        """A level that is all subfolders (no files) is bounded too.

        This is the bucket-root case: a files-only cap would never trip and would
        page through every folder name. The total-entry cap must catch it.
        """
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )
            # 60 distinct top-level "folders", zero files at this level.
            for i in range(60):
                client.put_object(Bucket="test-bucket", Key=f"folder{i:04d}/data.mcap", Body=b"x")

            result = s3_service.get_prefix_counts(client, "test-bucket", prefix="", max_items=25)

            assert result["success"] is True
            assert result["file_count"] == 0
            assert result["capped"] is True
            # Bounded: we did not enumerate all 60 folders.
            assert result["folder_count"] <= 25

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

    def test_generate_presigned_download_url(self) -> None:
        """Test generating a presigned download URL for an existing object."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )
            client.put_object(Bucket="test-bucket", Key="test/file.mcap", Body=b"test data")

            result = s3_service.generate_presigned_download_url(
                client, "test-bucket", "test/file.mcap"
            )

            assert result["success"] is True
            assert result["filename"] == "file.mcap"
            assert result["url"].startswith("https://")
            assert "test/file.mcap" in result["url"]

    def test_generate_presigned_download_url_missing(self) -> None:
        """Test that a missing object returns an error instead of a URL."""
        with mock_aws():
            client = boto3.client("s3", region_name="us-west-2")
            client.create_bucket(
                Bucket="test-bucket",
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )

            result = s3_service.generate_presigned_download_url(
                client, "test-bucket", "missing/file.mcap"
            )

            assert result["success"] is False
            assert "not found" in result["error"]


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

    @patch("boto3.Session")
    def test_caches_client_per_profile_region(self, mock_session: MagicMock) -> None:
        """Repeated calls reuse the cached client instead of rebuilding a session."""
        mock_session.return_value.client.return_value = MagicMock()

        first = s3_service.create_s3_client("p", "us-west-2")
        second = s3_service.create_s3_client("p", "us-west-2")

        assert first is second
        mock_session.assert_called_once()

    @patch("boto3.Session")
    def test_reset_cache_forces_rebuild(self, mock_session: MagicMock) -> None:
        """After a reset the next call builds a fresh session."""
        mock_session.return_value.client.return_value = MagicMock()

        s3_service.create_s3_client("p", "us-west-2")
        s3_service.reset_s3_client_cache()
        s3_service.create_s3_client("p", "us-west-2")

        assert mock_session.call_count == 2
