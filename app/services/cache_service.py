"""SQLite cache service for S3 file tracking."""

import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from mypy_boto3_s3 import S3Client


class CacheService:
    """Cache service with thread-safe SQLite access for S3 file tracking."""

    CACHE_FILE = "modaq_upload_cache.db"
    CACHE_TTL_SECONDS = 3600  # 1 hour default TTL

    def __init__(self) -> None:
        """Initialize the cache database."""
        self._db_path = Path(self.CACHE_FILE)
        self._local = threading.local()
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        """Get thread-local database connection."""
        if not hasattr(self._local, "connection") or self._local.connection is None:
            self._local.connection = sqlite3.connect(
                str(self._db_path),
                check_same_thread=False,
                timeout=30.0,
            )
            self._local.connection.row_factory = sqlite3.Row
        conn: sqlite3.Connection = self._local.connection
        return conn

    def _init_db(self) -> None:
        """Initialize the database schema."""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS s3_files (
                id INTEGER PRIMARY KEY,
                s3_path TEXT NOT NULL,
                bucket TEXT NOT NULL,
                filename TEXT DEFAULT '',
                file_size INTEGER DEFAULT 0,
                cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_verified TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                file_exists BOOLEAN DEFAULT 1,
                UNIQUE(bucket, s3_path)
            )
        """)

        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_bucket_path ON s3_files(bucket, s3_path)
        """)

        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_bucket ON s3_files(bucket)
        """)

        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_bucket_filename ON s3_files(bucket, filename, file_size)
        """)

        # Metadata table for tracking sync status per bucket
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS cache_metadata (
                bucket TEXT PRIMARY KEY,
                last_full_sync TIMESTAMP,
                last_sync_files_in_s3 INTEGER DEFAULT 0,
                last_sync_files_removed INTEGER DEFAULT 0
            )
        """)

        conn.commit()

    def check_exists_cached(
        self,
        bucket: str,
        s3_path: str,
        ttl: int | None = None,
    ) -> bool | None:
        """Check if a file exists in the cache.

        Args:
            bucket: S3 bucket name
            s3_path: S3 object key
            ttl: Time-to-live in seconds (default: CACHE_TTL_SECONDS)

        Returns:
            True if file exists in S3 (cached), False if not exists (cached),
            None if not in cache or cache expired
        """
        if ttl is None:
            ttl = self.CACHE_TTL_SECONDS

        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT file_exists, last_verified FROM s3_files
            WHERE bucket = ? AND s3_path = ?
            """,
            (bucket, s3_path),
        )

        row = cursor.fetchone()
        if row is None:
            return None

        # Check if cache entry is still valid
        last_verified = datetime.fromisoformat(row["last_verified"])
        # Handle naive timestamps (treat as UTC) for backward compatibility
        if last_verified.tzinfo is None:
            last_verified = last_verified.replace(tzinfo=UTC)
        if datetime.now(UTC) - last_verified > timedelta(seconds=ttl):
            return None  # Expired

        return bool(row["file_exists"])

    def check_exists_by_filename(
        self,
        bucket: str,
        filename: str,
        file_size: int,
    ) -> bool | None:
        """Check if a file exists in the cache by filename and size.

        Fallback lookup when the S3 path isn't known (e.g. pre-filter can't
        generate the same path as the actual MCAP analysis). No TTL is applied
        because if we uploaded a file, that fact doesn't expire.

        Args:
            bucket: S3 bucket name
            filename: Original filename
            file_size: File size in bytes

        Returns:
            True if any cache entry for this filename+size says it exists,
            None if no matching entry found
        """
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT 1 FROM s3_files
            WHERE bucket = ? AND filename = ? AND file_size = ? AND file_exists = 1
            LIMIT 1
            """,
            (bucket, filename, file_size),
        )

        row = cursor.fetchone()
        return True if row else None

    def update_cache(
        self,
        bucket: str,
        s3_path: str,
        exists: bool,
        filename: str = "",
        file_size: int = 0,
    ) -> None:
        """Update or insert a cache entry.

        Args:
            bucket: S3 bucket name
            s3_path: S3 object key
            exists: Whether the file exists in S3
            filename: Original filename
            file_size: File size in bytes
        """
        conn = self._get_connection()
        cursor = conn.cursor()

        now = datetime.now(UTC).isoformat()

        cursor.execute(
            """
            INSERT INTO s3_files
                (bucket, s3_path, file_exists, filename, file_size, cached_at, last_verified)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(bucket, s3_path) DO UPDATE SET
                file_exists = excluded.file_exists,
                filename = excluded.filename,
                file_size = excluded.file_size,
                last_verified = excluded.last_verified
            """,
            (bucket, s3_path, exists, filename, file_size, now, now),
        )

        conn.commit()

    def bulk_update_cache(
        self,
        bucket: str,
        entries: list[dict[str, Any]],
    ) -> None:
        """Bulk update cache entries.

        Args:
            bucket: S3 bucket name
            entries: List of dicts with keys: s3_path, exists, filename, file_size
        """
        conn = self._get_connection()
        cursor = conn.cursor()

        now = datetime.now(UTC).isoformat()

        data = [
            (
                bucket,
                entry["s3_path"],
                entry.get("exists", True),
                entry.get("filename", ""),
                entry.get("file_size", 0),
                now,
                now,
            )
            for entry in entries
        ]

        cursor.executemany(
            """
            INSERT INTO s3_files
                (bucket, s3_path, file_exists, filename, file_size, cached_at, last_verified)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(bucket, s3_path) DO UPDATE SET
                file_exists = excluded.file_exists,
                filename = excluded.filename,
                file_size = excluded.file_size,
                last_verified = excluded.last_verified
            """,
            data,
        )

        conn.commit()

    def get_uploaded_file_info(
        self,
        bucket: str,
        filename: str,
        file_size: int,
    ) -> dict[str, str | int] | None:
        """Look up a cached upload entry by filename and size.

        Returns the S3 path and file metadata for files where file_exists=1.
        Used by the delete feature to cross-reference local files with S3 uploads.

        Args:
            bucket: S3 bucket name
            filename: Original filename
            file_size: File size in bytes

        Returns:
            Dict with s3_path, filename, file_size if found, else None
        """
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT s3_path, filename, file_size FROM s3_files
            WHERE bucket = ? AND filename = ? AND file_size = ? AND file_exists = 1
            LIMIT 1
            """,
            (bucket, filename, file_size),
        )

        row = cursor.fetchone()
        if row is None:
            return None

        return {
            "s3_path": row["s3_path"],
            "filename": row["filename"],
            "file_size": row["file_size"],
        }

    def invalidate_bucket(self, bucket: str) -> int:
        """Invalidate all cache entries for a bucket.

        Args:
            bucket: S3 bucket name

        Returns:
            Number of entries deleted
        """
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("DELETE FROM s3_files WHERE bucket = ?", (bucket,))
        deleted = cursor.rowcount

        conn.commit()
        return deleted

    def get_cache_stats(self, bucket: str | None = None) -> dict[str, Any]:
        """Get cache statistics.

        Args:
            bucket: Optional bucket to filter by

        Returns:
            Dictionary with cache statistics
        """
        conn = self._get_connection()
        cursor = conn.cursor()

        if bucket:
            cursor.execute(
                """
                SELECT
                    COUNT(*) as total_entries,
                    SUM(CASE WHEN file_exists = 1 THEN 1 ELSE 0 END) as exists_count,
                    SUM(CASE WHEN file_exists = 0 THEN 1 ELSE 0 END) as not_exists_count,
                    MIN(cached_at) as oldest_entry,
                    MAX(last_verified) as newest_verification
                FROM s3_files
                WHERE bucket = ?
                """,
                (bucket,),
            )
        else:
            cursor.execute(
                """
                SELECT
                    COUNT(*) as total_entries,
                    SUM(CASE WHEN file_exists = 1 THEN 1 ELSE 0 END) as exists_count,
                    SUM(CASE WHEN file_exists = 0 THEN 1 ELSE 0 END) as not_exists_count,
                    MIN(cached_at) as oldest_entry,
                    MAX(last_verified) as newest_verification
                FROM s3_files
                """
            )

        row = cursor.fetchone()

        # Count expired entries
        ttl_cutoff = (datetime.now(UTC) - timedelta(seconds=self.CACHE_TTL_SECONDS)).isoformat()
        if bucket:
            cursor.execute(
                "SELECT COUNT(*) FROM s3_files WHERE bucket = ? AND last_verified < ?",
                (bucket, ttl_cutoff),
            )
        else:
            cursor.execute(
                "SELECT COUNT(*) FROM s3_files WHERE last_verified < ?",
                (ttl_cutoff,),
            )
        expired_count = cursor.fetchone()[0]

        # Get last sync metadata
        last_full_sync = None
        last_sync_files_removed = 0
        if bucket:
            cursor.execute(
                """SELECT last_full_sync, last_sync_files_removed
                FROM cache_metadata WHERE bucket = ?""",
                (bucket,),
            )
            meta_row = cursor.fetchone()
            if meta_row:
                last_full_sync = meta_row["last_full_sync"]
                last_sync_files_removed = meta_row["last_sync_files_removed"] or 0

        return {
            "total_entries": row["total_entries"] or 0,
            "exists_count": row["exists_count"] or 0,
            "not_exists_count": row["not_exists_count"] or 0,
            "expired_count": expired_count,
            "oldest_entry": row["oldest_entry"],
            "newest_verification": row["newest_verification"],
            "bucket": bucket,
            "ttl_seconds": self.CACHE_TTL_SECONDS,
            "last_full_sync": last_full_sync,
            "last_sync_files_removed": last_sync_files_removed,
        }

    def sync_with_s3_prefix(
        self,
        s3_client: S3Client,
        bucket: str,
        prefix: str = "",
    ) -> dict[str, Any]:
        """Sync cache with S3 bucket listing for a prefix.

        Args:
            s3_client: Configured S3 client
            bucket: S3 bucket name
            prefix: S3 key prefix to sync

        Returns:
            Dictionary with sync results
        """
        entries: list[dict[str, Any]] = []
        files_found = 0

        try:
            paginator = s3_client.get_paginator("list_objects_v2")
            page_iterator = paginator.paginate(Bucket=bucket, Prefix=prefix)

            for page in page_iterator:
                for obj in page.get("Contents", []):
                    key = obj.get("Key", "")
                    if key:
                        filename = key.split("/")[-1]
                        entries.append(
                            {
                                "s3_path": key,
                                "exists": True,
                                "filename": filename,
                                "file_size": obj.get("Size", 0),
                            }
                        )
                        files_found += 1

            # Bulk update cache
            if entries:
                self.bulk_update_cache(bucket, entries)

            return {
                "success": True,
                "bucket": bucket,
                "prefix": prefix,
                "files_synced": files_found,
                "error": None,
            }

        except Exception as e:
            return {
                "success": False,
                "bucket": bucket,
                "prefix": prefix,
                "files_synced": 0,
                "error": str(e),
            }

    def sync_and_reconcile_with_s3(
        self,
        s3_client: S3Client,
        bucket: str,
        prefix: str = "",
    ) -> dict[str, Any]:
        """Sync cache with S3 and mark deleted files as non-existent.

        This method:
        1. Lists all files currently in S3 with the given prefix
        2. Updates cache entries for files that exist
        3. Marks cached entries as file_exists=False if they're no longer in S3

        Args:
            s3_client: Configured S3 client
            bucket: S3 bucket name
            prefix: S3 key prefix to sync

        Returns:
            Dictionary with sync results including files_updated, files_removed counts
        """
        try:
            # Step 1: Get all S3 paths currently in the bucket
            s3_paths: set[str] = set()
            entries: list[dict[str, Any]] = []

            paginator = s3_client.get_paginator("list_objects_v2")
            page_iterator = paginator.paginate(Bucket=bucket, Prefix=prefix)

            for page in page_iterator:
                for obj in page.get("Contents", []):
                    key = obj.get("Key", "")
                    if key:
                        s3_paths.add(key)
                        filename = key.split("/")[-1]
                        entries.append(
                            {
                                "s3_path": key,
                                "exists": True,
                                "filename": filename,
                                "file_size": obj.get("Size", 0),
                            }
                        )

            # Step 2: Get all cached paths that are marked as existing
            conn = self._get_connection()
            cursor = conn.cursor()

            if prefix:
                cursor.execute(
                    """
                    SELECT s3_path FROM s3_files
                    WHERE bucket = ? AND file_exists = 1 AND s3_path LIKE ?
                    """,
                    (bucket, f"{prefix}%"),
                )
            else:
                cursor.execute(
                    """
                    SELECT s3_path FROM s3_files
                    WHERE bucket = ? AND file_exists = 1
                    """,
                    (bucket,),
                )

            cached_paths = {row["s3_path"] for row in cursor.fetchall()}

            # Step 3: Find paths that are in cache but not in S3 (deleted files)
            deleted_paths = cached_paths - s3_paths

            # Step 4: Update cache - mark existing files and deleted files
            files_updated = 0
            files_removed = 0

            if entries:
                self.bulk_update_cache(bucket, entries)
                files_updated = len(entries)

            # Mark deleted files as non-existent
            if deleted_paths:
                now = datetime.now(UTC).isoformat()
                cursor.executemany(
                    """
                    UPDATE s3_files
                    SET file_exists = 0, last_verified = ?
                    WHERE bucket = ? AND s3_path = ?
                    """,
                    [(now, bucket, path) for path in deleted_paths],
                )
                conn.commit()
                files_removed = len(deleted_paths)

            # Update sync metadata
            now = datetime.now(UTC).isoformat()
            cursor.execute(
                """
                INSERT INTO cache_metadata
                    (bucket, last_full_sync, last_sync_files_in_s3, last_sync_files_removed)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(bucket) DO UPDATE SET
                    last_full_sync = excluded.last_full_sync,
                    last_sync_files_in_s3 = excluded.last_sync_files_in_s3,
                    last_sync_files_removed = excluded.last_sync_files_removed
                """,
                (bucket, now, len(s3_paths), files_removed),
            )
            conn.commit()

            return {
                "success": True,
                "bucket": bucket,
                "prefix": prefix,
                "files_in_s3": len(s3_paths),
                "files_updated": files_updated,
                "files_removed": files_removed,
                "error": None,
            }

        except Exception as e:
            return {
                "success": False,
                "bucket": bucket,
                "prefix": prefix,
                "files_in_s3": 0,
                "files_updated": 0,
                "files_removed": 0,
                "error": str(e),
            }

    def close(self) -> None:
        """Close the database connection for the current thread."""
        if hasattr(self._local, "connection") and self._local.connection is not None:
            self._local.connection.close()
            self._local.connection = None


# Global cache instance
_cache_service: CacheService | None = None


def get_cache_service() -> CacheService:
    """Get the global cache service instance."""
    global _cache_service
    if _cache_service is None:
        _cache_service = CacheService()
    return _cache_service
