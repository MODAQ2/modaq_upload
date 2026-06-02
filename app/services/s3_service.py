"""S3 service for managing AWS S3 operations."""

import configparser
from collections.abc import Callable
from pathlib import Path
from typing import Any

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.exceptions import ClientError, NoCredentialsError
from mypy_boto3_s3 import S3Client
from mypy_boto3_s3.type_defs import PaginatorConfigTypeDef


class UploadCancelledError(Exception):
    """Raised when an upload is cancelled mid-transfer."""


# Multipart threshold: files below this size are uploaded as a single PUT request,
# which produces a simple MD5 ETag. Files above use multipart upload, which produces
# a composite ETag (md5_of_part_md5s-part_count) that can't be compared to a local MD5.
#
# The Local Delete feature relies on MD5 ETag comparison for integrity verification
# before deleting local files. Lowering this threshold means more files get multipart
# ETags and fall back to size-only verification (still safe, but less thorough).
#
# Guidelines:
#   < 100 MB files  → single-part fine, no multipart benefit
#   100 MB – 1 GB   → single-part fine on stable connections
#   1 – 5 GB        → multipart recommended (retry resilience)
#   > 5 GB          → multipart required (S3 hard limit)
#
# Our MCAP files are typically 50-100 MB, so 1 GB is very conservative.
TRANSFER_CONFIG = TransferConfig(multipart_threshold=1024 * 1024 * 1024)  # 1 GB


def get_available_profiles() -> list[str]:
    """Get list of available AWS profiles from ~/.aws/config and ~/.aws/credentials."""
    profiles: set[str] = set()

    # Check ~/.aws/credentials
    credentials_path = Path.home() / ".aws" / "credentials"
    if credentials_path.exists():
        config = configparser.ConfigParser()
        config.read(credentials_path)
        profiles.update(config.sections())

    # Check ~/.aws/config
    config_path = Path.home() / ".aws" / "config"
    if config_path.exists():
        config = configparser.ConfigParser()
        config.read(config_path)
        for section in config.sections():
            # Config file uses "profile name" format
            if section.startswith("profile "):
                profiles.add(section.replace("profile ", ""))
            else:
                profiles.add(section)

    # Always include default
    profiles.add("default")

    return sorted(profiles)


def create_s3_client(profile: str, region: str = "us-west-2") -> S3Client:
    """Create an S3 client using the specified AWS profile.

    Args:
        profile: AWS profile name from ~/.aws/credentials or ~/.aws/config
        region: AWS region (default: us-west-2)

    Returns:
        Configured S3 client

    Raises:
        NoCredentialsError: If credentials are not found
    """
    session = boto3.Session(profile_name=profile, region_name=region)
    client: S3Client = session.client("s3")
    return client


def check_file_exists(client: S3Client, bucket: str, key: str) -> bool:
    """Check if a file exists in S3.

    Args:
        client: S3 client
        bucket: S3 bucket name
        key: S3 object key

    Returns:
        True if file exists, False otherwise
    """
    try:
        client.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "404":
            return False
        raise


def upload_file_with_progress(
    client: S3Client,
    path: str,
    bucket: str,
    key: str,
    callback: Callable[[int, int], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """Upload a file to S3 with progress tracking.

    Args:
        client: S3 client
        path: Local file path
        bucket: S3 bucket name
        key: S3 object key
        callback: Progress callback function (bytes_uploaded, total_bytes)
        cancel_check: Callable that returns True if the upload should be cancelled.
            Checked on every progress callback (each chunk). When True, raises
            UploadCancelledError to abort the boto3 transfer immediately.

    Returns:
        Dictionary with upload result information

    Raises:
        UploadCancelledError: If cancel_check returns True during upload
    """
    file_path = Path(path)
    file_size = file_path.stat().st_size

    class ProgressCallback:
        """Callback class for tracking upload progress."""

        def __init__(
            self,
            total_size: int,
            user_callback: Callable[[int, int], None] | None,
            should_cancel: Callable[[], bool] | None,
        ) -> None:
            self.total_size = total_size
            self.uploaded = 0
            self.user_callback = user_callback
            self.should_cancel = should_cancel

        def __call__(self, bytes_amount: int) -> None:
            if self.should_cancel and self.should_cancel():
                raise UploadCancelledError(f"Upload cancelled for {key}")
            self.uploaded += bytes_amount
            if self.user_callback:
                self.user_callback(self.uploaded, self.total_size)

    progress = ProgressCallback(file_size, callback, cancel_check)

    try:
        client.upload_file(
            Filename=str(path),
            Bucket=bucket,
            Key=key,
            Callback=progress,
            Config=TRANSFER_CONFIG,
        )

        return {
            "success": True,
            "bucket": bucket,
            "key": key,
            "size": file_size,
            "error": None,
        }
    except UploadCancelledError:
        raise
    except ClientError as e:
        return {
            "success": False,
            "bucket": bucket,
            "key": key,
            "size": file_size,
            "error": str(e),
        }


def list_bucket_objects(
    client: S3Client,
    bucket: str,
    prefix: str = "",
    delimiter: str = "/",
    max_keys: int = 1000,
    continuation_token: str | None = None,
) -> dict[str, Any]:
    """List objects in an S3 bucket with prefix filtering, one page at a time.

    Returns at most ``max_keys`` items (folders + files combined). When more
    results exist, ``next_token`` is a non-null string the caller passes back as
    ``continuation_token`` to fetch the next page. This avoids silently truncating
    folders that contain more than ``max_keys`` objects.

    Args:
        client: S3 client
        bucket: S3 bucket name
        prefix: Object key prefix for filtering
        delimiter: Delimiter for grouping (default: /)
        max_keys: Maximum number of items to return per page
        continuation_token: Opaque token from a previous call's ``next_token`` to
            resume listing where the last page left off

    Returns:
        Dictionary containing folders, files, and ``next_token`` (None when done)
    """
    folders: list[dict[str, str]] = []
    files: list[dict[str, Any]] = []

    try:
        pagination_config: PaginatorConfigTypeDef = {"MaxItems": max_keys}
        if continuation_token:
            pagination_config["StartingToken"] = continuation_token

        paginator = client.get_paginator("list_objects_v2")
        page_iterator = paginator.paginate(
            Bucket=bucket,
            Prefix=prefix,
            Delimiter=delimiter,
            PaginationConfig=pagination_config,
        )

        for page in page_iterator:
            # Get common prefixes (folders). Note: when resuming from a
            # StartingToken these keys may be present but explicitly None, so
            # `or []` guards against iterating over None.
            for prefix_info in page.get("CommonPrefixes") or []:
                folder_prefix = prefix_info.get("Prefix", "")
                folder_name = folder_prefix.rstrip("/").split("/")[-1]
                folders.append({"name": folder_name, "prefix": folder_prefix})

            # Get objects (files)
            for obj in page.get("Contents") or []:
                key = obj.get("Key", "")
                # Skip the prefix itself if it's listed
                if key == prefix:
                    continue
                filename = key.split("/")[-1]
                if filename:  # Only include actual files
                    last_mod = obj.get("LastModified")
                    last_mod_str = last_mod.isoformat() if last_mod else ""
                    files.append(
                        {
                            "name": filename,
                            "key": key,
                            "size": obj.get("Size", 0),
                            "last_modified": last_mod_str,
                        }
                    )

        # resume_token is None once all results have been returned.
        next_token = page_iterator.resume_token

        return {
            "success": True,
            "bucket": bucket,
            "prefix": prefix,
            "folders": folders,
            "files": files,
            "next_token": next_token,
            "error": None,
        }
    except ClientError as e:
        return {
            "success": False,
            "bucket": bucket,
            "prefix": prefix,
            "folders": [],
            "files": [],
            "next_token": None,
            "error": str(e),
        }


def get_prefix_counts(
    client: S3Client,
    bucket: str,
    prefix: str = "",
    delimiter: str = "/",
) -> dict[str, Any]:
    """Count subfolders and files directly under a prefix (one level).

    Fully paginates the level so the counts are accurate regardless of how many
    objects it contains, unlike ``list_bucket_objects`` which returns one page.
    This is count-only (no sizes or metadata) to keep it cheap.

    Args:
        client: S3 client
        bucket: S3 bucket name
        prefix: Object key prefix for the folder to summarize
        delimiter: Delimiter for grouping (default: /)

    Returns:
        Dictionary with ``folder_count`` and ``file_count`` for this level
    """
    folder_prefixes: set[str] = set()
    file_count = 0

    try:
        paginator = client.get_paginator("list_objects_v2")
        page_iterator = paginator.paginate(Bucket=bucket, Prefix=prefix, Delimiter=delimiter)

        for page in page_iterator:
            for prefix_info in page.get("CommonPrefixes") or []:
                folder_prefixes.add(prefix_info.get("Prefix", ""))
            for obj in page.get("Contents") or []:
                key = obj.get("Key", "")
                # Skip the prefix placeholder object and any directory markers.
                if key == prefix or not key.split("/")[-1]:
                    continue
                file_count += 1

        return {
            "success": True,
            "prefix": prefix,
            "folder_count": len(folder_prefixes),
            "file_count": file_count,
            "error": None,
        }
    except ClientError as e:
        return {
            "success": False,
            "prefix": prefix,
            "folder_count": 0,
            "file_count": 0,
            "error": str(e),
        }


def validate_bucket_access(client: S3Client, bucket: str) -> dict[str, Any]:
    """Validate that we can access the specified S3 bucket.

    Args:
        client: S3 client
        bucket: S3 bucket name

    Returns:
        Dictionary with validation result
    """
    try:
        client.head_bucket(Bucket=bucket)
        return {
            "success": True,
            "bucket": bucket,
            "error": None,
        }
    except ClientError as e:
        error_code = e.response["Error"]["Code"]
        if error_code == "404":
            error_msg = f"Bucket '{bucket}' does not exist"
        elif error_code == "403":
            error_msg = f"Access denied to bucket '{bucket}'"
        else:
            error_msg = str(e)
        return {
            "success": False,
            "bucket": bucket,
            "error": error_msg,
        }
    except NoCredentialsError:
        return {
            "success": False,
            "bucket": bucket,
            "error": "AWS credentials not found",
        }


def get_s3_client_from_settings() -> tuple[S3Client, str]:
    """Create S3 client from current app settings. Returns (client, bucket)."""
    from app.config import get_settings

    settings = get_settings()
    client = create_s3_client(settings.aws_profile, settings.aws_region)
    return client, settings.s3_bucket


def generate_presigned_download_url(
    client: S3Client,
    bucket: str,
    key: str,
    expires_in: int = 3600,
) -> dict[str, Any]:
    """Generate a presigned URL for downloading an S3 object.

    The URL forces a browser download (Content-Disposition: attachment) with the
    object's original filename. Presigned URLs let the browser fetch directly from
    S3 rather than proxying large files through Flask.

    Args:
        client: S3 client
        bucket: S3 bucket name
        key: S3 object key
        expires_in: URL validity in seconds (default: 3600 = 1 hour)

    Returns:
        Dictionary with the presigned URL or an error
    """
    filename = key.split("/")[-1]
    try:
        # Confirm the object exists so a missing key returns 404 rather than a
        # presigned URL that later fails when the user clicks it.
        client.head_object(Bucket=bucket, Key=key)

        url = client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": bucket,
                "Key": key,
                "ResponseContentDisposition": f'attachment; filename="{filename}"',
            },
            ExpiresIn=expires_in,
        )
        return {
            "success": True,
            "url": url,
            "key": key,
            "filename": filename,
            "error": None,
        }
    except ClientError as e:
        error_code = e.response["Error"]["Code"]
        error_msg = f"File '{filename}' not found" if error_code == "404" else str(e)
        return {
            "success": False,
            "key": key,
            "error": error_msg,
        }


def get_object_metadata(client: S3Client, bucket: str, key: str) -> dict[str, Any]:
    """Get metadata for an S3 object.

    Args:
        client: S3 client
        bucket: S3 bucket name
        key: S3 object key

    Returns:
        Dictionary with object metadata
    """
    try:
        response = client.head_object(Bucket=bucket, Key=key)
        last_mod = response.get("LastModified")
        last_mod_str = last_mod.isoformat() if last_mod else ""
        return {
            "success": True,
            "bucket": bucket,
            "key": key,
            "size": response.get("ContentLength", 0),
            "last_modified": last_mod_str,
            "content_type": response.get("ContentType", ""),
            "etag": response.get("ETag", "").strip('"'),
            "error": None,
        }
    except ClientError as e:
        return {
            "success": False,
            "bucket": bucket,
            "key": key,
            "error": str(e),
        }
