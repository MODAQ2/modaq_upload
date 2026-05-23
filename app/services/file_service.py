"""File service for handling generic file operations and path generation."""

from datetime import UTC, datetime
from pathlib import Path

from app.config import get_settings
from app.services import mcap_service


def extract_timestamp(file_path: str, skip_validation: bool = False) -> datetime:
    """Extract timestamp from a file.

    For .mcap files, attempts to parse the internal timestamp (delegating to mcap_service).
    For other files, uses the file modification time (UTC).

    Args:
        file_path: Path to the file.
        skip_validation: If True, skips expensive MCAP parsing.

    Returns:
        datetime: The extracted timestamp (UTC).
    """
    path = Path(file_path)
    ext = path.suffix.lower()

    if ext == ".mcap":
        # For MCAP, try internal timestamp first
        try:
            return mcap_service.extract_start_time(file_path, skip_validation=skip_validation)
        except Exception:
            # Fallback to mtime if MCAP extraction fails (optional, but robust)
            pass

    # For non-MCAP (or failed MCAP), use filesystem modification time
    stat = path.stat()
    return datetime.fromtimestamp(stat.st_mtime, tz=UTC)


def get_file_category(filename: str) -> str:
    """Return the configured file category name for a given filename.

    Looks up the extension in the application's `file_categories` setting. Falls
    back to "other" when no category matches (the same fallback used by
    `generate_s3_key`).
    """
    settings = get_settings()
    ext = Path(filename).suffix.lower().lstrip(".")
    if not ext:
        return "other"
    for cat in settings.file_categories:
        if ext in [e.lower().lstrip(".") for e in cat.get("extensions", [])]:
            return str(cat.get("name", ext))
    return "other"


def generate_s3_key(filename: str, timestamp: datetime) -> str:
    """Generate Hive-partitioned S3 key based on file category configuration.

    The path structure and partition frequency are determined by the 'file_categories'
    setting in the application configuration.

    Args:
        filename: Name of the file.
        timestamp: Timestamp to use for partitioning.

    Returns:
        str: The S3 object key.
    """
    settings = get_settings()
    categories = settings.file_categories

    # Extract extension (lowercase, no dot)
    ext = Path(filename).suffix.lower().lstrip(".")
    if not ext:
        ext = "other"

    # Find category for this extension
    category_name = ext  # Default to extension name if no category found
    partition_interval = "daily"  # Default to daily

    for cat in categories:
        if ext in [e.lower().lstrip(".") for e in cat.get("extensions", [])]:
            category_name = cat.get("name", ext)
            partition_interval = cat.get("partition_interval", "daily")
            break

    # Base path: category/year/month/day
    base_path = (
        f"{category_name}/"
        f"year={timestamp.year:04d}/"
        f"month={timestamp.month:02d}/"
        f"day={timestamp.day:02d}"
    )

    if partition_interval == "10min":
        # 10-minute buckets
        minute_bucket = (timestamp.minute // 10) * 10
        return f"{base_path}/hour={timestamp.hour:02d}/minute={minute_bucket:02d}/{filename}"
    else:
        # Daily buckets (no hour/minute) - default fallback
        return f"{base_path}/{filename}"
