"""JSONL logging service for application events.

Writes one JSON object per line to hive-partitioned daily .jsonl files.
DuckDB-compatible: SELECT * FROM read_json_auto('logs/json/**/events.jsonl', hive_partitioning=true)
"""

import csv
import io
import json
import re
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.config import get_settings


class LogService:
    """JSONL log service with thread-safe file writes."""

    def __init__(self) -> None:
        """Initialize the log service."""
        self._write_lock = threading.Lock()

    def _get_log_dir(self) -> Path:
        """Get the configured log directory, creating it if needed."""
        settings = get_settings()
        log_dir = settings.log_directory
        log_dir.mkdir(parents=True, exist_ok=True)
        return log_dir

    def _get_hive_dir(self, subdir: str, dt: datetime) -> Path:
        """Build a hive-partitioned directory path and create it.

        Args:
            subdir: Top-level subdirectory ('json' or 'csv')
            dt: Datetime to partition by

        Returns:
            Path like logs/json/year=2026/month=02/day=08/
        """
        log_dir = self._get_log_dir()
        hive_dir = (
            log_dir
            / subdir
            / f"year={dt.year:04d}"
            / f"month={dt.month:02d}"
            / f"day={dt.day:02d}"
        )
        hive_dir.mkdir(parents=True, exist_ok=True)
        return hive_dir

    @staticmethod
    def _extract_date_from_hive_path(path: Path) -> str | None:
        """Extract YYYY-MM-DD date string from a hive-partitioned path.

        Looks for year=YYYY/month=MM/day=DD components in the path.

        Returns:
            Date string like '2026-02-08', or None if not found
        """
        path_str = str(path)
        match = re.search(r"year=(\d{4})/month=(\d{2})/day=(\d{2})", path_str)
        if match:
            return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
        return None

    def _get_current_log_file(self) -> Path:
        """Get the path to today's events log file (hive-partitioned)."""
        now = datetime.now(UTC)
        hive_dir = self._get_hive_dir("json", now)
        return hive_dir / "events.jsonl"

    def log(
        self,
        level: str,
        category: str,
        event: str,
        message: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Append a log entry to the current day's JSONL file.

        Args:
            level: Log level (INFO, WARNING, ERROR)
            category: Event category (upload, analysis, settings, app, sync)
            event: Machine-readable event name (snake_case)
            message: Human-readable message
            metadata: Optional additional data
        """
        entry: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": level.upper(),
            "category": category,
            "event": event,
            "message": message,
        }
        if metadata:
            entry["metadata"] = metadata

        line = json.dumps(entry, default=str)

        with self._write_lock:
            log_file = self._get_current_log_file()
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(line + "\n")

    def info(
        self,
        category: str,
        event: str,
        message: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Log an INFO-level event."""
        self.log("INFO", category, event, message, metadata)

    def warning(
        self,
        category: str,
        event: str,
        message: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Log a WARNING-level event."""
        self.log("WARNING", category, event, message, metadata)

    def error(
        self,
        category: str,
        event: str,
        message: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Log an ERROR-level event."""
        self.log("ERROR", category, event, message, metadata)

    def save_job_jsonl(
        self,
        job_id: str,
        job_dict: dict[str, Any],
        completed_at: datetime,
    ) -> Path:
        """Write a per-job JSONL summary file.

        Args:
            job_id: The upload job ID
            job_dict: Full job completion summary dict
            completed_at: When the job completed

        Returns:
            Path to the written file
        """
        hive_dir = self._get_hive_dir("json", completed_at)
        out_path = hive_dir / f"{job_id}.jsonl"
        line = json.dumps(job_dict, default=str)
        with self._write_lock:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(line + "\n")
        return out_path

    def save_job_csv(
        self,
        job_id: str,
        job: Any,
        completed_at: datetime,
    ) -> Path:
        """Write a per-job CSV upload summary.

        Args:
            job_id: The upload job ID
            job: UploadJob instance with file states
            completed_at: When the job completed

        Returns:
            Path to the written CSV file
        """
        from app.services.utils import format_file_size

        hive_dir = self._get_hive_dir("csv", completed_at)
        time_str = completed_at.strftime("%H%M%S")
        short_id = job_id[:8]
        out_path = hive_dir / f"upload-summary-{time_str}-{short_id}.csv"

        columns = [
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

        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(columns)

        for f in job.files:
            duration = f.upload_duration_seconds
            speed = (
                round(f.file_size / duration / 1024 / 1024 * 8, 2)
                if duration and duration > 0
                else None
            )
            writer.writerow([
                job_id,
                f.filename,
                f.file_size,
                format_file_size(f.file_size),
                f.s3_path,
                f.status.value,
                f.start_time.isoformat() if f.start_time else "",
                f.upload_started_at.isoformat() if f.upload_started_at else "",
                f.upload_completed_at.isoformat() if f.upload_completed_at else "",
                f.upload_duration_seconds,
                speed,
                f.is_duplicate,
                f.is_valid,
                f.error_message,
            ])

        with self._write_lock:
            with open(out_path, "w", encoding="utf-8", newline="") as fh:
                fh.write(buf.getvalue())

        return out_path

    def list_log_files(self) -> list[dict[str, Any]]:
        """List all log files (JSONL + CSV) with metadata.

        Returns:
            List of dicts with date, filename, path, size_bytes, relative_path, type
        """
        log_dir = self._get_log_dir()
        json_dir = log_dir / "json"
        csv_dir = log_dir / "csv"

        result: list[dict[str, Any]] = []

        # Collect JSONL files under json/
        if json_dir.exists():
            for f in sorted(json_dir.rglob("*.jsonl"), reverse=True):
                date_str = self._extract_date_from_hive_path(f)
                rel_path = f.relative_to(log_dir)
                result.append({
                    "date": date_str,
                    "filename": f.name,
                    "path": str(f),
                    "relative_path": str(rel_path),
                    "size_bytes": f.stat().st_size,
                    "type": "jsonl",
                })

        # Collect CSV files under csv/
        if csv_dir.exists():
            for f in sorted(csv_dir.rglob("*.csv"), reverse=True):
                date_str = self._extract_date_from_hive_path(f)
                rel_path = f.relative_to(log_dir)
                result.append({
                    "date": date_str,
                    "filename": f.name,
                    "path": str(f),
                    "relative_path": str(rel_path),
                    "size_bytes": f.stat().st_size,
                    "type": "csv",
                })

        return result

    def read_log_entries(
        self,
        date: str | None = None,
        level: str | None = None,
        category: str | None = None,
        search: str | None = None,
        offset: int = 0,
        limit: int = 100,
    ) -> dict[str, Any]:
        """Read and filter log entries with pagination.

        Args:
            date: Filter by date (YYYY-MM-DD). None = all dates.
            level: Filter by level (INFO/WARNING/ERROR)
            category: Filter by category
            search: Full-text search in message and event fields
            offset: Number of entries to skip
            limit: Maximum entries to return

        Returns:
            Dict with entries, total count, offset, limit
        """
        log_dir = self._get_log_dir()
        json_dir = log_dir / "json"

        # Determine which event files to read
        if date:
            # Parse date and construct hive path directly
            try:
                dt = datetime.strptime(date, "%Y-%m-%d")
            except ValueError:
                return {"entries": [], "total": 0, "offset": offset, "limit": limit}
            hive_path = (
                json_dir
                / f"year={dt.year:04d}"
                / f"month={dt.month:02d}"
                / f"day={dt.day:02d}"
                / "events.jsonl"
            )
            files = [hive_path] if hive_path.exists() else []
        else:
            if json_dir.exists():
                files = sorted(json_dir.rglob("events.jsonl"), reverse=True)
            else:
                files = []

        # Read and filter entries
        all_entries: list[dict[str, Any]] = []
        for log_file in files:
            try:
                with open(log_file, encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        # Apply filters
                        if level and entry.get("level", "").upper() != level.upper():
                            continue
                        if category and entry.get("category") != category:
                            continue
                        if search:
                            search_lower = search.lower()
                            msg = entry.get("message", "").lower()
                            evt = entry.get("event", "").lower()
                            if search_lower not in msg and search_lower not in evt:
                                continue

                        all_entries.append(entry)
            except OSError:
                continue

        # Sort by timestamp descending (newest first)
        all_entries.sort(key=lambda e: e.get("timestamp", ""), reverse=True)

        total = len(all_entries)
        paginated = all_entries[offset : offset + limit]

        return {
            "entries": paginated,
            "total": total,
            "offset": offset,
            "limit": limit,
        }

    def get_log_stats(self) -> dict[str, Any]:
        """Get aggregate statistics across all log files.

        Returns:
            Dict with counts by level/category, date range, totals
        """
        log_dir = self._get_log_dir()
        json_dir = log_dir / "json"
        csv_dir = log_dir / "csv"

        level_counts: dict[str, int] = {}
        category_counts: dict[str, int] = {}
        total_entries = 0
        total_size = 0
        today_count = 0
        today_str = datetime.now(UTC).strftime("%Y-%m-%d")
        dates: list[str] = []

        event_files = sorted(json_dir.rglob("events.jsonl")) if json_dir.exists() else []

        for log_file in event_files:
            total_size += log_file.stat().st_size
            date_str = self._extract_date_from_hive_path(log_file)
            if date_str and date_str not in dates:
                dates.append(date_str)
            is_today = date_str == today_str

            try:
                with open(log_file, encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        total_entries += 1
                        if is_today:
                            today_count += 1

                        lvl = entry.get("level", "UNKNOWN")
                        level_counts[lvl] = level_counts.get(lvl, 0) + 1

                        cat = entry.get("category", "unknown")
                        category_counts[cat] = category_counts.get(cat, 0) + 1
            except OSError:
                continue

        dates.sort()

        # Collect CSV file details
        csv_files: list[dict[str, Any]] = []
        if csv_dir.exists():
            for csv_file in sorted(csv_dir.rglob("*.csv"), reverse=True):
                date_str = self._extract_date_from_hive_path(csv_file) or ""
                rel_path = str(csv_file.relative_to(log_dir))
                csv_files.append({
                    "path": rel_path,
                    "filename": csv_file.name,
                    "date": date_str,
                    "size": csv_file.stat().st_size,
                })

        return {
            "total_entries": total_entries,
            "today_entries": today_count,
            "total_size_bytes": total_size,
            "level_counts": level_counts,
            "category_counts": category_counts,
            "date_range": {
                "earliest": dates[0] if dates else None,
                "latest": dates[-1] if dates else None,
            },
            "file_count": len(event_files),
            "csv_count": len(csv_files),
            "csv_files": csv_files,
        }

    def get_upload_stats(self) -> dict[str, Any]:
        """Parse all CSV upload summary files and return aggregated stats.

        Returns:
            Dict with global totals and per-session detail including file rows.
        """
        from app.services.utils import format_file_size

        log_dir = self._get_log_dir()
        csv_dir = log_dir / "csv"

        total_uploaded = 0
        total_failed = 0
        total_skipped = 0
        total_bytes = 0
        sessions: list[dict[str, Any]] = []

        if not csv_dir.exists():
            return {
                "total_files_uploaded": 0,
                "total_files_failed": 0,
                "total_files_skipped": 0,
                "total_bytes_uploaded": 0,
                "total_sessions": 0,
                "sessions": [],
            }

        for csv_file in sorted(csv_dir.rglob("*.csv"), reverse=True):
            rel_path = str(csv_file.relative_to(log_dir))
            date_str = self._extract_date_from_hive_path(csv_file) or ""

            # Extract time from filename: upload-summary-HHMMSS-shortid.csv
            fname = csv_file.stem  # e.g. upload-summary-143022-abcd1234
            parts = fname.split("-")
            time_str = ""
            if len(parts) >= 3:
                raw_time = parts[2]  # "143022"
                if len(raw_time) == 6 and raw_time.isdigit():
                    time_str = f"{raw_time[:2]}:{raw_time[2:4]}:{raw_time[4:6]}"

            session_files: list[dict[str, Any]] = []
            session_completed = 0
            session_failed = 0
            session_skipped = 0
            session_bytes = 0
            session_duration = 0.0

            try:
                with open(csv_file, encoding="utf-8", newline="") as fh:
                    reader = csv.DictReader(fh)
                    for row in reader:
                        status = row.get("status", "")
                        size_bytes = int(row.get("file_size_bytes", "0") or "0")
                        duration = float(row.get("upload_duration_seconds", "0") or "0")
                        speed = row.get("upload_speed_mbps", "")

                        if status == "completed":
                            session_completed += 1
                            session_bytes += size_bytes
                        elif status == "failed":
                            session_failed += 1
                        elif status == "skipped":
                            session_skipped += 1

                        session_duration += duration

                        session_files.append({
                            "filename": row.get("filename", ""),
                            "file_size_formatted": row.get("file_size_formatted", ""),
                            "status": status,
                            "upload_speed_mbps": speed,
                            "s3_path": row.get("s3_path", ""),
                            "error_message": row.get("error_message", ""),
                        })
            except (OSError, csv.Error):
                continue

            total_uploaded += session_completed
            total_failed += session_failed
            total_skipped += session_skipped
            total_bytes += session_bytes

            avg_speed = 0.0
            if session_duration > 0 and session_bytes > 0:
                avg_speed = round(session_bytes / session_duration / 1024 / 1024 * 8, 1)

            sessions.append({
                "csv_path": rel_path,
                "date": date_str,
                "time": time_str,
                "total_files": len(session_files),
                "completed": session_completed,
                "failed": session_failed,
                "skipped": session_skipped,
                "total_bytes": session_bytes,
                "total_bytes_formatted": format_file_size(session_bytes),
                "total_duration_seconds": round(session_duration, 1),
                "avg_speed_mbps": avg_speed,
                "files": session_files,
            })

        return {
            "total_files_uploaded": total_uploaded,
            "total_files_failed": total_failed,
            "total_files_skipped": total_skipped,
            "total_bytes_uploaded": total_bytes,
            "total_bytes_uploaded_formatted": format_file_size(total_bytes),
            "total_sessions": len(sessions),
            "sessions": sessions,
        }

    def sync_logs_to_s3(
        self,
        s3_client: Any,
        bucket: str,
        prefix: str = "logs/",
    ) -> dict[str, Any]:
        """Upload new/changed log files (JSONL + CSV) to S3.

        Tracks sync state in .sync_state.json to only upload changed files.
        Uses relative paths as both the sync state key and S3 key suffix.

        Args:
            s3_client: boto3 S3 client
            bucket: S3 bucket name
            prefix: S3 key prefix for log files

        Returns:
            Dict with sync results
        """
        log_dir = self._get_log_dir()
        sync_state_file = log_dir / ".sync_state.json"

        # Load previous sync state
        sync_state: dict[str, int] = {}
        if sync_state_file.exists():
            try:
                with open(sync_state_file, encoding="utf-8") as f:
                    sync_state = json.load(f)
            except (json.JSONDecodeError, OSError):
                sync_state = {}

        # Discover all JSONL under json/ and CSV under csv/
        files: list[Path] = []
        json_dir = log_dir / "json"
        csv_dir = log_dir / "csv"
        if json_dir.exists():
            files.extend(json_dir.rglob("*.jsonl"))
        if csv_dir.exists():
            files.extend(csv_dir.rglob("*.csv"))

        synced = 0
        skipped = 0
        errors: list[str] = []

        for log_file in files:
            rel_path = str(log_file.relative_to(log_dir))
            current_size = log_file.stat().st_size
            last_synced_size = sync_state.get(rel_path, 0)

            if current_size == last_synced_size:
                skipped += 1
                continue

            s3_key = f"{prefix}{rel_path}"
            try:
                s3_client.upload_file(str(log_file), bucket, s3_key)
                sync_state[rel_path] = current_size
                synced += 1
            except Exception as e:
                errors.append(f"{rel_path}: {e}")

        # Save updated sync state
        try:
            with open(sync_state_file, "w", encoding="utf-8") as f:
                json.dump(sync_state, f, indent=2)
        except OSError:
            pass

        self.info(
            "sync",
            "log_sync_completed",
            f"Synced {synced} log files to S3",
            {"synced": synced, "skipped": skipped, "errors": len(errors)},
        )

        return {
            "success": len(errors) == 0,
            "synced": synced,
            "skipped": skipped,
            "errors": errors,
            "total_files": len(files),
        }


# Module-level singleton accessor
_log_service: LogService | None = None


def get_log_service() -> LogService:
    """Get the singleton LogService instance."""
    global _log_service
    if _log_service is None:
        _log_service = LogService()
    return _log_service
