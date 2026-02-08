"""Logs API routes for modaq_upload"""

import csv
from pathlib import Path

from flask import Blueprint, Response, jsonify, request, send_file

from app.config import get_settings
from app.services import s3_service
from app.services.log_service import get_log_service

logs_bp = Blueprint("logs", __name__)


@logs_bp.route("/entries", methods=["GET"])
def get_log_entries() -> tuple[Response, int]:
    """Query log entries with filtering and pagination.

    Query params:
        date: Filter by date (YYYY-MM-DD)
        level: Filter by level (INFO/WARNING/ERROR)
        category: Filter by category (upload/analysis/settings/app/sync)
        search: Full-text search in message and event
        offset: Pagination offset (default 0)
        limit: Pagination limit (default 100)

    Returns:
        JSON with entries, total, offset, limit
    """
    log = get_log_service()

    date = request.args.get("date")
    level = request.args.get("level")
    category = request.args.get("category")
    search = request.args.get("search")
    offset = request.args.get("offset", "0")
    limit = request.args.get("limit", "100")

    try:
        offset_int = max(0, int(offset))
        limit_int = max(1, min(1000, int(limit)))
    except ValueError:
        offset_int = 0
        limit_int = 100

    result = log.read_log_entries(
        date=date,
        level=level,
        category=category,
        search=search,
        offset=offset_int,
        limit=limit_int,
    )

    return jsonify(result), 200


@logs_bp.route("/files", methods=["GET"])
def get_log_files() -> tuple[Response, int]:
    """List all log files with metadata.

    Returns:
        JSON with list of log files (date, filename, size)
    """
    log = get_log_service()
    files = log.list_log_files()
    return jsonify({"files": files}), 200


@logs_bp.route("/stats", methods=["GET"])
def get_log_stats() -> tuple[Response, int]:
    """Get aggregate log statistics.

    Returns:
        JSON with counts by level/category, date range, totals
    """
    log = get_log_service()
    stats = log.get_log_stats()
    return jsonify(stats), 200


@logs_bp.route("/sync", methods=["POST"])
def sync_logs() -> tuple[Response, int]:
    """Trigger S3 sync of log files.

    Returns:
        JSON with sync results (synced, skipped, errors)
    """
    settings = get_settings()

    if not settings.s3_bucket:
        return jsonify({"success": False, "error": "S3 bucket not configured"}), 400

    log = get_log_service()
    log.info("sync", "log_sync_started", "Starting log sync to S3")

    try:
        client = s3_service.create_s3_client(settings.aws_profile, settings.aws_region)
        result = log.sync_logs_to_s3(client, settings.s3_bucket)
        return jsonify(result), 200
    except Exception as e:
        log.error("sync", "log_sync_failed", f"Log sync failed: {e}", {"error": str(e)})
        return jsonify({"success": False, "error": str(e)}), 200


def _resolve_csv_path(relative_path: str) -> Path | None:
    """Resolve a relative CSV path safely within the log directory.

    Returns the absolute path if valid, or None if the path is invalid or
    escapes the log directory.
    """
    settings = get_settings()
    log_dir = settings.log_directory
    if not log_dir.is_absolute():
        from app.config import BASE_DIR

        log_dir = BASE_DIR / log_dir

    resolved = (log_dir / relative_path).resolve()
    try:
        resolved.relative_to(log_dir.resolve())
    except ValueError:
        return None
    if not resolved.is_file() or resolved.suffix != ".csv":
        return None
    return resolved


@logs_bp.route("/csv-download", methods=["GET"])
def csv_download() -> tuple[Response, int] | Response:
    """Serve a CSV file for browser download.

    Query params:
        path: Relative path within the log directory
              (e.g. csv/year=2026/month=02/day=08/upload-summary-143022-abcd1234.csv)
    """
    relative_path = request.args.get("path", "")
    if not relative_path:
        return jsonify({"error": "Missing path parameter"}), 400

    resolved = _resolve_csv_path(relative_path)
    if resolved is None:
        return jsonify({"error": "Invalid path"}), 400

    return send_file(resolved, as_attachment=True, download_name=resolved.name)


@logs_bp.route("/csv-preview", methods=["GET"])
def csv_preview() -> tuple[Response, int]:
    """Parse a CSV and return JSON for in-page viewing.

    Query params:
        path: Relative path within the log directory

    Returns:
        JSON with columns list and rows list of dicts
    """
    relative_path = request.args.get("path", "")
    if not relative_path:
        return jsonify({"error": "Missing path parameter"}), 400

    resolved = _resolve_csv_path(relative_path)
    if resolved is None:
        return jsonify({"error": "Invalid path"}), 400

    try:
        with open(resolved, encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            columns = reader.fieldnames or []
            rows = list(reader)
        return jsonify({"columns": columns, "rows": rows}), 200
    except Exception as e:
        return jsonify({"error": f"Failed to read CSV: {e}"}), 500
