"""MCAP service for parsing MCAP files and extracting metadata."""

import re
from datetime import UTC, datetime
from pathlib import Path

import pandas as pd


def _extract_timestamp_from_filename(filename: str) -> datetime | None:
    """Try to extract a timestamp from the filename.

    Supports patterns like:
    - Bag_2026_01_22_17_10_46_0.mcap (YYYY_MM_DD_HH_mm_ss)
    - 2026-01-22_17-10-46.mcap
    - recording_20260122_171046.mcap

    Returns:
        datetime or None if no pattern matches
    """
    # Pattern: Bag_YYYY_MM_DD_HH_mm_ss
    match = re.search(r"(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})", filename)
    if match:
        try:
            return datetime(
                year=int(match.group(1)),
                month=int(match.group(2)),
                day=int(match.group(3)),
                hour=int(match.group(4)),
                minute=int(match.group(5)),
                second=int(match.group(6)),
            )
        except ValueError:
            pass

    # Pattern: YYYY-MM-DD_HH-mm-ss or YYYY-MM-DD-HH-mm-ss
    match = re.search(r"(\d{4})-(\d{2})-(\d{2})[-_](\d{2})-(\d{2})-(\d{2})", filename)
    if match:
        try:
            return datetime(
                year=int(match.group(1)),
                month=int(match.group(2)),
                day=int(match.group(3)),
                hour=int(match.group(4)),
                minute=int(match.group(5)),
                second=int(match.group(6)),
            )
        except ValueError:
            pass

    # Pattern: YYYYMMDD_HHmmss or YYYYMMDD-HHmmss
    match = re.search(r"(\d{4})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})", filename)
    if match:
        try:
            return datetime(
                year=int(match.group(1)),
                month=int(match.group(2)),
                day=int(match.group(3)),
                hour=int(match.group(4)),
                minute=int(match.group(5)),
                second=int(match.group(6)),
            )
        except ValueError:
            pass

    return None


def _find_datetime_in_dataframes(dataframes: dict[str, pd.DataFrame]) -> datetime | None:
    """Search dataframes for datetime columns or valid datetime indices.

    Returns:
        The earliest valid datetime found, or None
    """
    earliest_time: datetime | None = None
    epoch_cutoff = datetime(1980, 1, 1, tzinfo=UTC)

    for _topic_name, df in dataframes.items():
        if df is None or len(df) == 0:
            continue

        # First, try the index
        try:
            first_ts = df.index[0]
            topic_time = None

            if hasattr(first_ts, "to_pydatetime"):
                topic_time = first_ts.to_pydatetime()
            elif isinstance(first_ts, datetime):
                topic_time = first_ts

            # Check if it's a valid timestamp (after 1980)
            if topic_time is not None:
                # Make timezone-naive for comparison
                check_time = topic_time.replace(tzinfo=None) if topic_time.tzinfo else topic_time
                if check_time > epoch_cutoff.replace(tzinfo=None):
                    if earliest_time is None or check_time < earliest_time.replace(tzinfo=None):
                        earliest_time = topic_time
        except Exception:
            pass

        # Then, check columns for datetime types
        for col in df.columns:
            try:
                col_data = df[col]
                if len(col_data) == 0:
                    continue

                first_val = col_data.iloc[0]

                # Check if it's a datetime type
                if pd.api.types.is_datetime64_any_dtype(col_data):
                    if pd.notna(first_val):
                        if hasattr(first_val, "to_pydatetime"):
                            topic_time = first_val.to_pydatetime()
                        else:
                            topic_time = pd.Timestamp(first_val).to_pydatetime()

                        check_time = (
                            topic_time.replace(tzinfo=None) if topic_time.tzinfo else topic_time
                        )
                        if check_time > epoch_cutoff.replace(tzinfo=None):
                            if earliest_time is None or check_time < earliest_time.replace(
                                tzinfo=None
                            ):
                                earliest_time = topic_time

                # Check for timestamp-like column names
                elif col.lower() in ("timestamp", "time", "datetime", "date"):
                    if pd.notna(first_val):
                        # Try to parse as datetime
                        try:
                            if isinstance(first_val, int | float):
                                # Could be Unix timestamp (seconds or nanoseconds)
                                if first_val > 1e18:  # Nanoseconds
                                    topic_time = pd.Timestamp(first_val, unit="ns").to_pydatetime()
                                elif first_val > 1e15:  # Microseconds
                                    topic_time = pd.Timestamp(first_val, unit="us").to_pydatetime()
                                elif first_val > 1e12:  # Milliseconds
                                    topic_time = pd.Timestamp(first_val, unit="ms").to_pydatetime()
                                else:  # Seconds
                                    topic_time = datetime.fromtimestamp(first_val)

                                check_time = (
                                    topic_time.replace(tzinfo=None)
                                    if topic_time.tzinfo
                                    else topic_time
                                )
                                if check_time > epoch_cutoff.replace(tzinfo=None):
                                    if earliest_time is None or check_time < earliest_time.replace(
                                        tzinfo=None
                                    ):
                                        earliest_time = topic_time
                        except Exception:
                            pass
            except Exception:
                continue

    return earliest_time


def extract_start_time(file_path: Path | str) -> datetime:
    """Extract the earliest timestamp from an MCAP file using modaq_toolkit.

    Tries multiple strategies:
    1. Parse MCAP file and look for datetime indices/columns
    2. Extract timestamp from filename if MCAP parsing fails or returns invalid dates

    Args:
        file_path: Path to the MCAP file

    Returns:
        datetime: The earliest timestamp found in the MCAP file

    Raises:
        ValueError: If the file cannot be parsed or has no timestamps
        FileNotFoundError: If the file does not exist
    """
    from modaq_toolkit import MCAPParser

    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"MCAP file not found: {path}")

    earliest_time: datetime | None = None
    epoch_cutoff = datetime(1980, 1, 1)

    try:
        parser = MCAPParser(path)

        # Try with datetime conversion first
        try:
            dataframes = parser.get_dataframes(
                process_stage2=True,
                stage_2_convert_ros_time_to_utc_datetime_index=True,
            )
            earliest_time = _find_datetime_in_dataframes(dataframes)
        except Exception:
            pass

        # If no valid time found, try without conversion
        if earliest_time is None:
            try:
                dataframes = parser.get_dataframes(process_stage2=False)
                earliest_time = _find_datetime_in_dataframes(dataframes)
            except Exception:
                pass

    except ImportError as e:
        raise ImportError(
            "modaq_toolkit is required for MCAP parsing. "
            "Install with: pip install git+https://github.com/MODAQ2/MODAQ_toolkit.git"
        ) from e
    except Exception:
        pass  # Will fall back to filename parsing

    # Validate the timestamp - must be after 1980
    if earliest_time is not None:
        check_time = earliest_time.replace(tzinfo=None) if earliest_time.tzinfo else earliest_time
        if check_time < epoch_cutoff:
            earliest_time = None  # Invalid timestamp, try filename

    # Fallback: try to extract from filename
    if earliest_time is None:
        earliest_time = _extract_timestamp_from_filename(path.name)

    if earliest_time is None:
        raise ValueError(f"Could not extract timestamps from MCAP file: {path}")

    return earliest_time


def generate_s3_path(start_time: datetime, filename: str) -> str:
    """Generate a Hive-partitioned S3 path based on timestamp.

    The path format is: year=YYYY/month=MM/day=DD/hour=HH/minute=M0/filename
    Minutes are rounded to 10-minute buckets (00, 10, 20, 30, 40, 50).

    Args:
        start_time: The timestamp to use for partitioning
        filename: The original filename

    Returns:
        str: The Hive-partitioned S3 path
    """
    # Round minutes to 10-minute bucket
    minute_bucket = (start_time.minute // 10) * 10

    path = (
        f"year={start_time.year:04d}/"
        f"month={start_time.month:02d}/"
        f"day={start_time.day:02d}/"
        f"hour={start_time.hour:02d}/"
        f"minute={minute_bucket:02d}/"
        f"{filename}"
    )

    return path


def get_file_info(file_path: Path | str) -> dict[str, str | int | None]:
    """Get information about an MCAP file.

    Args:
        file_path: Path to the MCAP file

    Returns:
        Dictionary containing file information
    """
    path = Path(file_path)

    info: dict[str, str | int | None] = {
        "filename": path.name,
        "path": str(path.absolute()),
        "size": path.stat().st_size if path.exists() else 0,
        "start_time": None,
        "s3_path": None,
        "error": None,
    }

    try:
        start_time = extract_start_time(path)
        info["start_time"] = start_time.isoformat()
        info["s3_path"] = generate_s3_path(start_time, path.name)
    except Exception as e:
        info["error"] = str(e)

    return info


def format_file_size(size_bytes: int) -> str:
    """Format a file size in bytes to a human-readable string.

    Args:
        size_bytes: Size in bytes

    Returns:
        Human-readable size string (e.g., "1.5 GB")
    """
    size_float = float(size_bytes)
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if abs(size_float) < 1024.0:
            return f"{size_float:.1f} {unit}"
        size_float = size_float / 1024.0
    return f"{size_float:.1f} PB"
