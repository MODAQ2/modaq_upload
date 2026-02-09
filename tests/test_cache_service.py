"""Tests for the cache service module."""

import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import app.services.cache_service as cache_module
from app.services.cache_service import CacheService, get_cache_service


@pytest.fixture
def temp_cache_db(monkeypatch: pytest.MonkeyPatch) -> Path:
    """Create a temporary cache database file."""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        temp_path = Path(f.name)

    # Patch the CACHE_FILE class attribute
    monkeypatch.setattr(CacheService, "CACHE_FILE", str(temp_path))
    # Reset module-level singleton so get_cache_service() creates a fresh instance
    monkeypatch.setattr(cache_module, "_cache_service", None)

    yield temp_path

    # Cleanup
    if temp_path.exists():
        temp_path.unlink()


@pytest.fixture
def cache_service(temp_cache_db: Path) -> CacheService:
    """Create a CacheService instance with a temp database."""
    service = CacheService()
    return service


class TestCacheServiceSchema:
    """Tests for cache database schema."""

    def test_creates_database(self, cache_service: CacheService, temp_cache_db: Path) -> None:
        """Test that database is created."""
        assert temp_cache_db.exists()

    def test_creates_s3_files_table(self, cache_service: CacheService) -> None:
        """Test that s3_files table is created."""
        conn = cache_service._get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='s3_files'")
        result = cursor.fetchone()
        assert result is not None

    def test_creates_indexes(self, cache_service: CacheService) -> None:
        """Test that indexes are created."""
        conn = cache_service._get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='index'")
        indexes = [row[0] for row in cursor.fetchall()]

        assert "idx_bucket_path" in indexes
        assert "idx_bucket" in indexes


class TestCheckExistsCached:
    """Tests for check_exists_cached method."""

    def test_returns_none_for_uncached_path(self, cache_service: CacheService) -> None:
        """Test that None is returned for paths not in cache."""
        result = cache_service.check_exists_cached("test-bucket", "path/to/file.mcap")
        assert result is None

    def test_returns_true_for_existing_file(self, cache_service: CacheService) -> None:
        """Test that True is returned for cached existing files."""
        cache_service.update_cache("test-bucket", "path/to/file.mcap", exists=True)
        result = cache_service.check_exists_cached("test-bucket", "path/to/file.mcap")
        assert result is True

    def test_returns_false_for_nonexisting_file(self, cache_service: CacheService) -> None:
        """Test that False is returned for cached non-existing files."""
        cache_service.update_cache("test-bucket", "path/to/file.mcap", exists=False)
        result = cache_service.check_exists_cached("test-bucket", "path/to/file.mcap")
        assert result is False

    def test_returns_none_for_expired_entry(
        self, cache_service: CacheService, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test that None is returned for expired cache entries."""
        cache_service.update_cache("test-bucket", "path/to/file.mcap", exists=True)

        # Check with very short TTL (entry should be expired)
        result = cache_service.check_exists_cached("test-bucket", "path/to/file.mcap", ttl=0)
        # The entry was just created, so with TTL=0 it might still be valid
        # Use a negative timestamp test instead
        conn = cache_service._get_connection()
        cursor = conn.cursor()
        old_time = (datetime.now() - timedelta(hours=2)).isoformat()
        cursor.execute(
            "UPDATE s3_files SET last_verified = ? WHERE bucket = ? AND s3_path = ?",
            (old_time, "test-bucket", "path/to/file.mcap"),
        )
        conn.commit()

        # Now it should be expired with default TTL
        result = cache_service.check_exists_cached("test-bucket", "path/to/file.mcap")
        assert result is None

    def test_respects_bucket_scope(self, cache_service: CacheService) -> None:
        """Test that cache is scoped by bucket."""
        cache_service.update_cache("bucket-a", "path/file.mcap", exists=True)
        cache_service.update_cache("bucket-b", "path/file.mcap", exists=False)

        assert cache_service.check_exists_cached("bucket-a", "path/file.mcap") is True
        assert cache_service.check_exists_cached("bucket-b", "path/file.mcap") is False


class TestUpdateCache:
    """Tests for update_cache method."""

    def test_inserts_new_entry(self, cache_service: CacheService) -> None:
        """Test inserting a new cache entry."""
        cache_service.update_cache(
            "test-bucket",
            "path/to/file.mcap",
            exists=True,
            filename="file.mcap",
            file_size=1024,
        )

        conn = cache_service._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM s3_files WHERE bucket = ? AND s3_path = ?",
            ("test-bucket", "path/to/file.mcap"),
        )
        row = cursor.fetchone()

        assert row is not None
        assert row["file_exists"] == 1
        assert row["filename"] == "file.mcap"
        assert row["file_size"] == 1024

    def test_updates_existing_entry(self, cache_service: CacheService) -> None:
        """Test updating an existing cache entry."""
        cache_service.update_cache("test-bucket", "path/file.mcap", exists=False)
        cache_service.update_cache("test-bucket", "path/file.mcap", exists=True)

        result = cache_service.check_exists_cached("test-bucket", "path/file.mcap")
        assert result is True


class TestBulkUpdateCache:
    """Tests for bulk_update_cache method."""

    def test_bulk_inserts_entries(self, cache_service: CacheService) -> None:
        """Test bulk inserting cache entries."""
        entries = [
            {"s3_path": "path/file1.mcap", "exists": True, "filename": "file1.mcap"},
            {"s3_path": "path/file2.mcap", "exists": True, "filename": "file2.mcap"},
            {"s3_path": "path/file3.mcap", "exists": False, "filename": "file3.mcap"},
        ]

        cache_service.bulk_update_cache("test-bucket", entries)

        assert cache_service.check_exists_cached("test-bucket", "path/file1.mcap") is True
        assert cache_service.check_exists_cached("test-bucket", "path/file2.mcap") is True
        assert cache_service.check_exists_cached("test-bucket", "path/file3.mcap") is False

    def test_bulk_handles_empty_list(self, cache_service: CacheService) -> None:
        """Test bulk update with empty list."""
        cache_service.bulk_update_cache("test-bucket", [])
        # Should not raise


class TestInvalidateBucket:
    """Tests for invalidate_bucket method."""

    def test_deletes_all_entries_for_bucket(self, cache_service: CacheService) -> None:
        """Test that all entries for a bucket are deleted."""
        cache_service.update_cache("bucket-a", "file1.mcap", exists=True)
        cache_service.update_cache("bucket-a", "file2.mcap", exists=True)
        cache_service.update_cache("bucket-b", "file1.mcap", exists=True)

        deleted = cache_service.invalidate_bucket("bucket-a")

        assert deleted == 2
        assert cache_service.check_exists_cached("bucket-a", "file1.mcap") is None
        assert cache_service.check_exists_cached("bucket-a", "file2.mcap") is None
        assert cache_service.check_exists_cached("bucket-b", "file1.mcap") is True

    def test_returns_zero_for_empty_bucket(self, cache_service: CacheService) -> None:
        """Test that zero is returned for bucket with no entries."""
        deleted = cache_service.invalidate_bucket("nonexistent-bucket")
        assert deleted == 0


class TestGetCacheStats:
    """Tests for get_cache_stats method."""

    def test_returns_stats_for_bucket(self, cache_service: CacheService) -> None:
        """Test getting stats for a specific bucket."""
        cache_service.update_cache("test-bucket", "file1.mcap", exists=True)
        cache_service.update_cache("test-bucket", "file2.mcap", exists=True)
        cache_service.update_cache("test-bucket", "file3.mcap", exists=False)

        stats = cache_service.get_cache_stats("test-bucket")

        assert stats["total_entries"] == 3
        assert stats["exists_count"] == 2
        assert stats["not_exists_count"] == 1
        assert stats["bucket"] == "test-bucket"

    def test_returns_global_stats(self, cache_service: CacheService) -> None:
        """Test getting stats for all buckets."""
        cache_service.update_cache("bucket-a", "file1.mcap", exists=True)
        cache_service.update_cache("bucket-b", "file1.mcap", exists=True)

        stats = cache_service.get_cache_stats()

        assert stats["total_entries"] == 2
        assert stats["bucket"] is None

    def test_returns_empty_stats(self, cache_service: CacheService) -> None:
        """Test getting stats with no entries."""
        stats = cache_service.get_cache_stats("empty-bucket")

        assert stats["total_entries"] == 0
        assert stats["exists_count"] == 0
        assert stats["not_exists_count"] == 0

    def test_counts_expired_entries(
        self, cache_service: CacheService, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test that expired entries are counted."""
        cache_service.update_cache("test-bucket", "file1.mcap", exists=True)
        cache_service.update_cache("test-bucket", "file2.mcap", exists=True)

        # Make one entry expired
        conn = cache_service._get_connection()
        cursor = conn.cursor()
        old_time = (datetime.now() - timedelta(hours=2)).isoformat()
        cursor.execute(
            "UPDATE s3_files SET last_verified = ? WHERE s3_path = ?",
            (old_time, "file1.mcap"),
        )
        conn.commit()

        stats = cache_service.get_cache_stats("test-bucket")

        assert stats["expired_count"] == 1


class TestSyncWithS3Prefix:
    """Tests for sync_with_s3_prefix method."""

    def test_syncs_files_from_s3(self, cache_service: CacheService) -> None:
        """Test syncing files from S3."""
        mock_client = MagicMock()
        mock_paginator = MagicMock()
        mock_client.get_paginator.return_value = mock_paginator
        mock_paginator.paginate.return_value = [
            {
                "Contents": [
                    {"Key": "prefix/file1.mcap", "Size": 1000},
                    {"Key": "prefix/file2.mcap", "Size": 2000},
                ]
            }
        ]

        result = cache_service.sync_with_s3_prefix(mock_client, "test-bucket", "prefix/")

        assert result["success"] is True
        assert result["files_synced"] == 2
        assert cache_service.check_exists_cached("test-bucket", "prefix/file1.mcap") is True
        assert cache_service.check_exists_cached("test-bucket", "prefix/file2.mcap") is True

    def test_handles_s3_error(self, cache_service: CacheService) -> None:
        """Test handling S3 errors during sync."""
        mock_client = MagicMock()
        mock_client.get_paginator.side_effect = Exception("S3 error")

        result = cache_service.sync_with_s3_prefix(mock_client, "test-bucket", "prefix/")

        assert result["success"] is False
        assert "S3 error" in result["error"]


class TestGetCacheServiceSingleton:
    """Tests for get_cache_service function."""

    def test_returns_same_instance(
        self, temp_cache_db: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test that get_cache_service returns a singleton."""
        # Reset the global instance
        import app.services.cache_service as cache_module

        monkeypatch.setattr(cache_module, "_cache_service", None)

        service1 = get_cache_service()
        service2 = get_cache_service()

        assert service1 is service2
