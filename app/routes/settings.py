"""Settings API routes for modaq_upload"""

import os
import signal
import sys
import threading

from flask import Blueprint, Response, jsonify, request

from app.config import get_package_version, get_settings, get_updater
from app.services import s3_service
from app.services.cache_service import get_cache_service
from app.services.log_service import get_log_service

settings_bp = Blueprint("settings", __name__)


@settings_bp.route("", methods=["GET"])
def get_all_settings() -> tuple[Response, int]:
    """Get all current settings.

    Returns:
        JSON response with all settings
    """
    settings = get_settings()
    return jsonify(settings.all()), 200


@settings_bp.route("", methods=["PUT"])
def update_settings() -> tuple[Response, int]:
    """Update settings.

    Request body:
        JSON object with settings to update

    Returns:
        JSON response with updated settings
    """
    if not request.is_json:
        return jsonify({"error": "JSON body required"}), 400

    data = request.get_json()
    if not data:
        return jsonify({"error": "Empty body"}), 400

    settings = get_settings()

    # Validate settings
    allowed_keys = {
        "aws_profile", "aws_region", "s3_bucket", "default_upload_folder", "display_name",
        "log_directory",
    }
    filtered_data = {k: v for k, v in data.items() if k in allowed_keys}

    if not filtered_data:
        return jsonify({"error": "No valid settings provided"}), 400

    settings.update(filtered_data)

    log = get_log_service()
    log.info(
        "settings",
        "settings_updated",
        f"Updated settings: {', '.join(filtered_data.keys())}",
        {"changed_keys": list(filtered_data.keys())},
    )

    return jsonify(settings.all()), 200


@settings_bp.route("/profiles", methods=["GET"])
def get_profiles() -> tuple[Response, int]:
    """Get list of available AWS profiles.

    Returns:
        JSON response with list of profile names
    """
    profiles = s3_service.get_available_profiles()
    return jsonify({"profiles": profiles}), 200


@settings_bp.route("/validate", methods=["POST"])
def validate_connection() -> tuple[Response, int]:
    """Validate S3 connection with current or provided settings.

    Request body (optional):
        aws_profile: AWS profile to test
        aws_region: AWS region to test
        s3_bucket: S3 bucket to test

    Returns:
        JSON response with validation result
    """
    settings = get_settings()

    # Use provided values or fall back to current settings
    if request.is_json:
        data = request.get_json() or {}
        profile = data.get("aws_profile", settings.aws_profile)
        region = data.get("aws_region", settings.aws_region)
        bucket = data.get("s3_bucket", settings.s3_bucket)
    else:
        profile = settings.aws_profile
        region = settings.aws_region
        bucket = settings.s3_bucket

    if not bucket:
        return jsonify({"error": "S3 bucket not specified"}), 400

    log = get_log_service()
    try:
        client = s3_service.create_s3_client(profile, region)
        result = s3_service.validate_bucket_access(client, bucket)

        if result["success"]:
            log.info(
                "settings",
                "connection_test",
                f"Connection test succeeded for bucket '{bucket}'",
                {"bucket": bucket, "profile": profile, "region": region, "success": True},
            )
            return jsonify(
                {
                    "success": True,
                    "message": f"Successfully connected to bucket '{bucket}'",
                }
            ), 200
        else:
            log.warning(
                "settings",
                "connection_test",
                f"Connection test failed for bucket '{bucket}': {result['error']}",
                {
                    "bucket": bucket,
                    "profile": profile,
                    "region": region,
                    "success": False,
                    "error": result["error"],
                },
            )
            return jsonify(
                {
                    "success": False,
                    "error": result["error"],
                }
            ), 200

    except Exception as e:
        log.error(
            "settings",
            "connection_test",
            f"Connection test error for bucket '{bucket}': {e}",
            {"bucket": bucket, "profile": profile, "region": region, "error": str(e)},
        )
        return jsonify(
            {
                "success": False,
                "error": str(e),
            }
        ), 200


@settings_bp.route("/version", methods=["GET"])
def get_version() -> tuple[Response, int]:
    """Get current application version information.

    Returns:
        JSON response with version info
    """
    updater = get_updater()
    info = updater.get_version_info()
    # Add package version from pyproject.toml
    info["version"] = get_package_version()
    return jsonify(info), 200


@settings_bp.route("/check-updates", methods=["GET"])
def check_updates() -> tuple[Response, int]:
    """Check if updates are available.

    Returns:
        JSON response with update availability
    """
    updater = get_updater()
    result = updater.check_for_updates()
    return jsonify(result), 200


@settings_bp.route("/update", methods=["POST"])
def run_update() -> tuple[Response, int]:
    """Run application update (git pull + pip install).

    Returns:
        JSON response with update results
    """
    updater = get_updater()
    result = updater.update_application()

    # Determine overall success
    all_success = all(step["success"] for step in result.values())

    return jsonify(
        {
            "success": all_success,
            "results": result,
            "message": "Update completed successfully"
            if all_success
            else "Update completed with some errors",
        }
    ), 200


@settings_bp.route("/cache/stats", methods=["GET"])
def get_cache_stats() -> tuple[Response, int]:
    """Get cache statistics for the current bucket.

    Returns:
        JSON response with cache statistics
    """
    settings = get_settings()
    cache = get_cache_service()

    stats = cache.get_cache_stats(bucket=settings.s3_bucket)

    return jsonify(
        {
            "success": True,
            "stats": stats,
        }
    ), 200


@settings_bp.route("/cache/invalidate", methods=["POST"])
def invalidate_cache() -> tuple[Response, int]:
    """Invalidate cache entries for the current bucket.

    Returns:
        JSON response with number of entries deleted
    """
    settings = get_settings()
    cache = get_cache_service()

    deleted = cache.invalidate_bucket(settings.s3_bucket)

    return jsonify(
        {
            "success": True,
            "deleted": deleted,
            "bucket": settings.s3_bucket,
            "message": f"Invalidated {deleted} cache entries for bucket '{settings.s3_bucket}'",
        }
    ), 200


@settings_bp.route("/shutdown", methods=["POST"])
def shutdown_server() -> tuple[Response, int]:
    """Gracefully shut down the application server.

    Detects whether we're running under gunicorn or the Flask dev server
    and sends the appropriate signal after a brief delay so the HTTP
    response can be returned to the client first.

    - Gunicorn: sends SIGTERM to the master (parent) process, which
      triggers a graceful shutdown of all workers.
    - Flask dev server: sends SIGINT to the current process.

    Returns:
        JSON response confirming shutdown was initiated
    """
    log = get_log_service()
    log.info("app", "shutdown_requested", "Graceful shutdown requested via settings UI")

    def _shutdown() -> None:
        if "gunicorn" in sys.modules:
            # Under gunicorn, the worker's parent is the master process.
            # SIGTERM tells the master to finish active requests and exit.
            os.kill(os.getppid(), signal.SIGTERM)
        else:
            os.kill(os.getpid(), signal.SIGINT)

    # Delay slightly so the response reaches the client
    timer = threading.Timer(0.5, _shutdown)
    timer.daemon = True
    timer.start()

    return jsonify({"success": True, "message": "Server is shutting down..."}), 200


@settings_bp.route("/cache/sync", methods=["POST"])
def sync_cache_with_s3() -> tuple[Response, int]:
    """Sync cache with S3, marking deleted files as non-existent.

    This reconciles the local cache with the actual S3 bucket state,
    removing entries for files that were deleted from S3.

    Returns:
        JSON response with sync results
    """
    settings = get_settings()
    cache = get_cache_service()

    if not settings.s3_bucket:
        return jsonify({"success": False, "error": "S3 bucket not configured"}), 400

    try:
        client = s3_service.create_s3_client(settings.aws_profile, settings.aws_region)
        result = cache.sync_and_reconcile_with_s3(client, settings.s3_bucket)

        if result["success"]:
            return jsonify(
                {
                    "success": True,
                    "bucket": result["bucket"],
                    "files_in_s3": result["files_in_s3"],
                    "files_updated": result["files_updated"],
                    "files_removed": result["files_removed"],
                    "message": f"Synced cache with S3. Found {result['files_in_s3']} files, "
                    f"marked {result['files_removed']} as deleted.",
                }
            ), 200
        else:
            return jsonify(
                {
                    "success": False,
                    "error": result["error"],
                }
            ), 200

    except Exception as e:
        return jsonify(
            {
                "success": False,
                "error": str(e),
            }
        ), 200
