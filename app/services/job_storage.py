"""Database-backed storage for large upload/delete jobs."""

import json
import logging
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from typing import Any

from app.config import BASE_DIR

logger = logging.getLogger(__name__)

# Database file location
DB_FILE = BASE_DIR / "upload_jobs.db"

# SQL schema
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS upload_jobs (
    job_id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL,
    total_files INTEGER NOT NULL,
    files_processed INTEGER DEFAULT 0,
    files_uploaded INTEGER DEFAULT 0,
    files_failed INTEGER DEFAULT 0,
    total_bytes INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    metadata TEXT
);

CREATE TABLE IF NOT EXISTS upload_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    local_path TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    status TEXT NOT NULL,
    s3_path TEXT,
    start_time TEXT,
    bytes_uploaded INTEGER DEFAULT 0,
    error_message TEXT,
    is_duplicate INTEGER DEFAULT 0,
    is_valid INTEGER DEFAULT 1,
    upload_started_at TEXT,
    upload_completed_at TEXT,
    FOREIGN KEY (job_id) REFERENCES upload_jobs(job_id)
);

CREATE INDEX IF NOT EXISTS idx_upload_files_job_id ON upload_files(job_id);
CREATE INDEX IF NOT EXISTS idx_upload_files_status ON upload_files(status);
CREATE INDEX IF NOT EXISTS idx_upload_jobs_created_at ON upload_jobs(created_at);
"""


class JobStorage:
    """SQLite-backed storage for upload/delete jobs."""

    _instance: "JobStorage | None" = None
    _lock = threading.Lock()

    def __new__(cls) -> "JobStorage":
        """Singleton pattern to ensure only one storage instance."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialize_db()
        return cls._instance

    def _initialize_db(self) -> None:
        """Initialize the database and create tables if needed."""
        try:
            conn = sqlite3.connect(str(DB_FILE), check_same_thread=False)
            # WAL mode lets one writer + many readers proceed concurrently —
            # required because per-file status updates fire from upload worker
            # threads while the Flask route handlers serve /api/upload/results.
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA_SQL)
            conn.commit()
            conn.close()
            logger.info(f"Job storage database initialized at {DB_FILE}")
        except Exception as e:
            logger.error(f"Failed to initialize job storage database: {e}", exc_info=True)
            raise

    def _get_connection(self) -> sqlite3.Connection:
        """Get a database connection."""
        conn = sqlite3.connect(str(DB_FILE), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def save_job(
        self,
        job_id: str,
        job_type: str,
        total_files: int,
        file_states: list[dict[str, Any]],
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Save a new job to the database.

        Args:
            job_id: Unique job identifier
            job_type: Type of job ('upload' or 'delete')
            total_files: Total number of files in job
            file_states: List of file state dictionaries
            metadata: Optional job metadata
        """
        try:
            conn = self._get_connection()
            cursor = conn.cursor()

            # Insert job record
            cursor.execute(
                """
                INSERT INTO upload_jobs (
                    job_id, job_type, status, total_files, created_at, metadata
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    job_type,
                    "pending",
                    total_files,
                    datetime.now(UTC).isoformat(),
                    json.dumps(metadata) if metadata else None,
                ),
            )

            # Insert file records
            for file_state in file_states:
                cursor.execute(
                    """
                    INSERT INTO upload_files (
                        job_id, filename, local_path, file_size, status,
                        s3_path, start_time, is_duplicate, is_valid
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id,
                        file_state.get("filename", ""),
                        file_state.get("local_path", ""),
                        file_state.get("file_size", 0),
                        file_state.get("status", "pending"),
                        file_state.get("s3_path", ""),
                        file_state.get("start_time"),
                        1 if file_state.get("is_duplicate", False) else 0,
                        1 if file_state.get("is_valid", True) else 0,
                    ),
                )

            conn.commit()
            conn.close()
            logger.info(f"Saved job {job_id} with {len(file_states)} files to database")

        except Exception as e:
            logger.error(f"Failed to save job {job_id}: {e}", exc_info=True)
            raise

    def update_job_status(
        self,
        job_id: str,
        status: str,
        files_processed: int | None = None,
        files_uploaded: int | None = None,
        files_failed: int | None = None,
        total_bytes: int | None = None,
        started_at: datetime | None = None,
        completed_at: datetime | None = None,
    ) -> None:
        """Update job status and statistics.

        Args:
            job_id: Job identifier
            status: New job status
            files_processed: Number of files processed (optional)
            files_uploaded: Number of files uploaded (optional)
            files_failed: Number of files failed (optional)
            total_bytes: Total bytes uploaded (optional)
            started_at: Job start time (optional)
            completed_at: Job completion time (optional)
        """
        try:
            conn = self._get_connection()
            cursor = conn.cursor()

            # Build dynamic UPDATE query
            updates = ["status = ?"]
            params: list[Any] = [status]

            if files_processed is not None:
                updates.append("files_processed = ?")
                params.append(files_processed)

            if files_uploaded is not None:
                updates.append("files_uploaded = ?")
                params.append(files_uploaded)

            if files_failed is not None:
                updates.append("files_failed = ?")
                params.append(files_failed)

            if total_bytes is not None:
                updates.append("total_bytes = ?")
                params.append(total_bytes)

            if started_at is not None:
                updates.append("started_at = ?")
                params.append(started_at.isoformat())

            if completed_at is not None:
                updates.append("completed_at = ?")
                params.append(completed_at.isoformat())

            params.append(job_id)

            query = f"UPDATE upload_jobs SET {', '.join(updates)} WHERE job_id = ?"
            cursor.execute(query, params)

            conn.commit()
            conn.close()

        except Exception as e:
            logger.error(f"Failed to update job {job_id}: {e}", exc_info=True)
            raise

    def update_file_status(
        self,
        job_id: str,
        filename: str,
        status: str,
        bytes_uploaded: int | None = None,
        error_message: str | None = None,
        upload_started_at: datetime | None = None,
        upload_completed_at: datetime | None = None,
    ) -> None:
        """Update status of a specific file in a job.

        Args:
            job_id: Job identifier
            filename: Filename to update
            status: New file status
            bytes_uploaded: Bytes uploaded (optional)
            error_message: Error message (optional)
            upload_started_at: Upload start time (optional)
            upload_completed_at: Upload completion time (optional)
        """
        try:
            conn = self._get_connection()
            cursor = conn.cursor()

            # Build dynamic UPDATE query
            updates = ["status = ?"]
            params: list[Any] = [status]

            if bytes_uploaded is not None:
                updates.append("bytes_uploaded = ?")
                params.append(bytes_uploaded)

            if error_message is not None:
                updates.append("error_message = ?")
                params.append(error_message)

            if upload_started_at is not None:
                updates.append("upload_started_at = ?")
                params.append(upload_started_at.isoformat())

            if upload_completed_at is not None:
                updates.append("upload_completed_at = ?")
                params.append(upload_completed_at.isoformat())

            params.extend([job_id, filename])

            query = (
                f"UPDATE upload_files SET {', '.join(updates)} WHERE job_id = ? AND filename = ?"
            )
            cursor.execute(query, params)

            conn.commit()
            conn.close()

        except Exception as e:
            logger.error(f"Failed to update file {filename} in job {job_id}: {e}", exc_info=True)

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        """Get job metadata by ID.

        Args:
            job_id: Job identifier

        Returns:
            Job metadata dict or None if not found
        """
        try:
            conn = self._get_connection()
            cursor = conn.cursor()

            cursor.execute(
                """
                SELECT job_id, job_type, status, total_files,
                       files_processed, files_uploaded, files_failed, total_bytes,
                       created_at, started_at, completed_at, metadata
                FROM upload_jobs
                WHERE job_id = ?
                """,
                (job_id,),
            )

            row = cursor.fetchone()
            conn.close()

            if row is None:
                return None

            return {
                "job_id": row["job_id"],
                "job_type": row["job_type"],
                "status": row["status"],
                "total_files": row["total_files"],
                "files_processed": row["files_processed"],
                "files_uploaded": row["files_uploaded"],
                "files_failed": row["files_failed"],
                "total_bytes": row["total_bytes"],
                "created_at": row["created_at"],
                "started_at": row["started_at"],
                "completed_at": row["completed_at"],
                "metadata": json.loads(row["metadata"]) if row["metadata"] else {},
            }

        except Exception as e:
            logger.error(f"Failed to get job {job_id}: {e}", exc_info=True)
            return None

    def get_job_results(self, job_id: str, page: int = 1, per_page: int = 100) -> dict[str, Any]:
        """Get paginated file results for a job.

        Args:
            job_id: Job identifier
            page: Page number (1-indexed)
            per_page: Results per page (default 100)

        Returns:
            Dict with 'files' list and pagination info
        """
        try:
            conn = self._get_connection()
            cursor = conn.cursor()

            # Get total count
            cursor.execute("SELECT COUNT(*) as count FROM upload_files WHERE job_id = ?", (job_id,))
            total_files = cursor.fetchone()["count"]

            # Get paginated files
            offset = (page - 1) * per_page
            cursor.execute(
                """
                SELECT filename, local_path, file_size, status, s3_path,
                       start_time, bytes_uploaded, error_message,
                       is_duplicate, is_valid, upload_started_at, upload_completed_at
                FROM upload_files
                WHERE job_id = ?
                ORDER BY id
                LIMIT ? OFFSET ?
                """,
                (job_id, per_page, offset),
            )

            files = []
            for row in cursor.fetchall():
                files.append(
                    {
                        "filename": row["filename"],
                        "local_path": row["local_path"],
                        "file_size": row["file_size"],
                        "status": row["status"],
                        "s3_path": row["s3_path"],
                        "start_time": row["start_time"],
                        "bytes_uploaded": row["bytes_uploaded"],
                        "error_message": row["error_message"],
                        "is_duplicate": bool(row["is_duplicate"]),
                        "is_valid": bool(row["is_valid"]),
                        "upload_started_at": row["upload_started_at"],
                        "upload_completed_at": row["upload_completed_at"],
                    }
                )

            conn.close()

            total_pages = (total_files + per_page - 1) // per_page

            return {
                "job_id": job_id,
                "files": files,
                "pagination": {
                    "page": page,
                    "per_page": per_page,
                    "total_files": total_files,
                    "total_pages": total_pages,
                    "has_next": page < total_pages,
                    "has_prev": page > 1,
                },
            }

        except Exception as e:
            logger.error(f"Failed to get results for job {job_id}: {e}", exc_info=True)
            return {"job_id": job_id, "files": [], "pagination": {}}

    def cleanup_old_jobs(self, days: int = 7) -> int:
        """Delete jobs older than specified days.

        Args:
            days: Age threshold in days

        Returns:
            Number of jobs deleted
        """
        try:
            cutoff_date = datetime.now(UTC) - timedelta(days=days)
            conn = self._get_connection()
            cursor = conn.cursor()

            # Delete old files first (foreign key constraint)
            cursor.execute(
                """
                DELETE FROM upload_files
                WHERE job_id IN (
                    SELECT job_id FROM upload_jobs
                    WHERE created_at < ?
                )
                """,
                (cutoff_date.isoformat(),),
            )

            # Delete old jobs
            cursor.execute(
                "DELETE FROM upload_jobs WHERE created_at < ?",
                (cutoff_date.isoformat(),),
            )

            deleted_count = cursor.rowcount
            conn.commit()
            conn.close()

            logger.info(f"Cleaned up {deleted_count} jobs older than {days} days")
            return deleted_count

        except Exception as e:
            logger.error(f"Failed to cleanup old jobs: {e}", exc_info=True)
            return 0


def get_job_storage() -> JobStorage:
    """Get the singleton JobStorage instance."""
    return JobStorage()
