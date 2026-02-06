"""S3 service for managing AWS S3 operations."""

import configparser
from collections.abc import Callable
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError, NoCredentialsError
from mypy_boto3_s3 import S3Client


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
) -> dict[str, Any]:
    """Upload a file to S3 with progress tracking.

    Args:
        client: S3 client
        path: Local file path
        bucket: S3 bucket name
        key: S3 object key
        callback: Progress callback function (bytes_uploaded, total_bytes)

    Returns:
        Dictionary with upload result information
    """
    file_path = Path(path)
    file_size = file_path.stat().st_size

    class ProgressCallback:
        """Callback class for tracking upload progress."""

        def __init__(
            self, total_size: int, user_callback: Callable[[int, int], None] | None
        ) -> None:
            self.total_size = total_size
            self.uploaded = 0
            self.user_callback = user_callback

        def __call__(self, bytes_amount: int) -> None:
            self.uploaded += bytes_amount
            if self.user_callback:
                self.user_callback(self.uploaded, self.total_size)

    progress = ProgressCallback(file_size, callback)

    try:
        client.upload_file(
            Filename=str(path),
            Bucket=bucket,
            Key=key,
            Callback=progress,
        )

        return {
            "success": True,
            "bucket": bucket,
            "key": key,
            "size": file_size,
            "error": None,
        }
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
) -> dict[str, Any]:
    """List objects in an S3 bucket with prefix filtering.

    Args:
        client: S3 client
        bucket: S3 bucket name
        prefix: Object key prefix for filtering
        delimiter: Delimiter for grouping (default: /)
        max_keys: Maximum number of keys to return

    Returns:
        Dictionary containing folders and files
    """
    folders: list[dict[str, str]] = []
    files: list[dict[str, Any]] = []

    try:
        paginator = client.get_paginator("list_objects_v2")
        page_iterator = paginator.paginate(
            Bucket=bucket,
            Prefix=prefix,
            Delimiter=delimiter,
            PaginationConfig={"MaxItems": max_keys},
        )

        for page in page_iterator:
            # Get common prefixes (folders)
            for prefix_info in page.get("CommonPrefixes", []):
                folder_prefix = prefix_info.get("Prefix", "")
                folder_name = folder_prefix.rstrip("/").split("/")[-1]
                folders.append({"name": folder_name, "prefix": folder_prefix})

            # Get objects (files)
            for obj in page.get("Contents", []):
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

        return {
            "success": True,
            "bucket": bucket,
            "prefix": prefix,
            "folders": folders,
            "files": files,
            "error": None,
        }
    except ClientError as e:
        return {
            "success": False,
            "bucket": bucket,
            "prefix": prefix,
            "folders": [],
            "files": [],
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
