"""Flask application factory for MCAP S3 Uploader."""

import atexit
import os
import threading
import time
import traceback

from flask import Flask, g, jsonify, request
from flask.wrappers import Response
from werkzeug.exceptions import HTTPException

from app.config import get_package_version, get_settings

# Background cleanup thread control
_cleanup_thread: threading.Thread | None = None
_cleanup_stop_event = threading.Event()

# Background log-sync thread control
_log_sync_thread: threading.Thread | None = None
_log_sync_stop_event = threading.Event()
# Set to wake the sync worker immediately (e.g. right after an error is logged).
_log_sync_trigger_event = threading.Event()
# How often to sync logs to S3 when nothing has triggered an early sync (seconds).
_LOG_SYNC_INTERVAL = 300
# Request paths to exclude from automatic per-request logging (noisy / would
# create feedback loops with the logging pipeline itself).
_REQUEST_LOG_SKIP_PREFIXES = ("/api/logs", "/api/upload/progress")


def _sse_cleanup_worker() -> None:
    """Background worker that periodically cleans up stale SSE queues."""
    from app.services.sse_manager import get_sse_manager

    while not _cleanup_stop_event.wait(timeout=300):  # Check every 5 minutes
        try:
            removed = get_sse_manager().cleanup_old_queues()
            if removed > 0:
                from app.services.log_service import get_log_service

                log = get_log_service()
                log.info(
                    "sse",
                    "sse_cleanup",
                    f"Cleaned up {removed} stale SSE queues",
                    {"queues_removed": removed},
                )
        except Exception:
            # Don't crash the cleanup thread on errors
            pass


def _start_sse_cleanup() -> None:
    """Start the background SSE cleanup thread."""
    global _cleanup_thread
    if _cleanup_thread is None:
        _cleanup_thread = threading.Thread(
            target=_sse_cleanup_worker, daemon=True, name="SSECleanup"
        )
        _cleanup_thread.start()


def _stop_sse_cleanup() -> None:
    """Stop the background SSE cleanup thread."""
    _cleanup_stop_event.set()
    if _cleanup_thread:
        _cleanup_thread.join(timeout=2.0)


def _run_log_sync() -> None:
    """Sync log files to S3 once, if a bucket is configured.

    Failures are logged as WARNING (never ERROR) so that a persistently failing
    sync cannot re-trigger itself through the error hook and hot-loop.
    """
    from app.services import s3_service
    from app.services.log_service import get_log_service

    settings = get_settings()
    log = get_log_service()

    if not settings.s3_bucket:
        return  # Nothing to sync to yet; stay quiet.

    try:
        client = s3_service.create_s3_client(settings.aws_profile, settings.aws_region)
        log.sync_logs_to_s3(client, settings.s3_bucket)
    except Exception as e:
        log.warning(
            "sync",
            "log_sync_failed",
            f"Automatic log sync to S3 failed: {e}",
            {"error": str(e)},
        )


def _log_sync_worker() -> None:
    """Background worker: sync logs to S3 periodically and on demand.

    Wakes every ``_LOG_SYNC_INTERVAL`` seconds, or immediately whenever
    ``_log_sync_trigger_event`` is set (e.g. just after an error is logged).
    """
    while not _log_sync_stop_event.is_set():
        # Wait for either the interval to elapse or an explicit trigger.
        _log_sync_trigger_event.wait(timeout=_LOG_SYNC_INTERVAL)
        if _log_sync_stop_event.is_set():
            break
        _log_sync_trigger_event.clear()
        _run_log_sync()


def _start_log_sync() -> None:
    """Start the background log-sync thread and register the error trigger."""
    global _log_sync_thread

    from app.services.log_service import get_log_service

    # Logging an ERROR wakes the sync worker for a near-immediate upload.
    get_log_service().set_error_callback(_log_sync_trigger_event.set)

    if _log_sync_thread is None:
        _log_sync_thread = threading.Thread(target=_log_sync_worker, daemon=True, name="LogSync")
        _log_sync_thread.start()


def _stop_log_sync() -> None:
    """Stop the background log-sync thread (flushing one final sync)."""
    _log_sync_stop_event.set()
    _log_sync_trigger_event.set()  # Wake it so it can observe the stop flag.
    if _log_sync_thread:
        _log_sync_thread.join(timeout=2.0)


def _register_logging_hooks(app: Flask) -> None:
    """Wire up automatic per-request logging and a global error handler.

    - Every ``/api/*`` request is logged (method, path, status, duration) so user
      actions are captured without per-route boilerplate.
    - Any uncaught exception is logged at ERROR level with a traceback, which also
      triggers a near-immediate S3 sync via the log service's error hook.
    """
    from app.services.log_service import get_log_service

    def _should_log(path: str) -> bool:
        return path.startswith("/api/") and not path.startswith(_REQUEST_LOG_SKIP_PREFIXES)

    @app.before_request
    def _stamp_request_start() -> None:
        g._request_start = time.monotonic()

    @app.after_request
    def _log_request(response: Response) -> Response:
        if _should_log(request.path):
            start = getattr(g, "_request_start", None)
            duration_ms = round((time.monotonic() - start) * 1000, 1) if start else None
            level = "WARNING" if response.status_code >= 400 else "INFO"
            get_log_service().log(
                level,
                "request",
                "http_request",
                f"{request.method} {request.path} -> {response.status_code}",
                {
                    "method": request.method,
                    "path": request.path,
                    "status": response.status_code,
                    "duration_ms": duration_ms,
                    "remote_addr": request.remote_addr,
                },
            )
        return response

    @app.errorhandler(Exception)
    def _handle_uncaught(error: Exception) -> Response | tuple[Response, int] | HTTPException:
        # Let normal HTTP errors (404, 405, explicit aborts, ...) keep their
        # default handling; only true crashes are logged as ERROR.
        if isinstance(error, HTTPException):
            return error
        get_log_service().error(
            "error",
            "unhandled_exception",
            f"Unhandled {type(error).__name__} on {request.method} {request.path}: {error}",
            {
                "exception_type": type(error).__name__,
                "method": request.method,
                "path": request.path,
                "traceback": traceback.format_exc(),
            },
        )
        return jsonify({"error": "Internal server error"}), 500


def create_app() -> Flask:
    """Create and configure the Flask application."""
    app = Flask(__name__)

    # Load configuration
    settings = get_settings()
    app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-key-change-in-production")
    app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024 * 1024  # 16 GB max upload

    # Store settings in app config for easy access
    app.config["SETTINGS"] = settings

    # Inject display_name into all templates
    @app.context_processor
    def inject_display_name() -> dict[str, str]:
        return {"display_name": settings.display_name}

    # Register blueprints
    from app.routes.delete import delete_bp
    from app.routes.files import files_bp
    from app.routes.large_folder_upload import large_folder_upload_bp
    from app.routes.logs import logs_bp
    from app.routes.main import main_bp
    from app.routes.settings import settings_bp
    from app.routes.upload import upload_bp

    app.register_blueprint(main_bp)
    app.register_blueprint(upload_bp, url_prefix="/api/upload")
    app.register_blueprint(files_bp, url_prefix="/api/files")
    app.register_blueprint(settings_bp, url_prefix="/api/settings")
    app.register_blueprint(logs_bp, url_prefix="/api/logs")
    app.register_blueprint(delete_bp, url_prefix="/api/delete")
    app.register_blueprint(large_folder_upload_bp, url_prefix="/api/large-folder-upload")

    # Automatic request/error logging hooks
    _register_logging_hooks(app)

    # Start background SSE cleanup thread
    _start_sse_cleanup()

    # Start background log-sync thread (periodic + error-triggered S3 upload)
    _start_log_sync()

    # Register cleanup on shutdown
    atexit.register(_stop_sse_cleanup)
    atexit.register(_stop_log_sync)

    # Log application startup
    from app.services.log_service import get_log_service

    log = get_log_service()
    log.info(
        "app",
        "app_started",
        f"Application started (v{get_package_version()})",
        {"version": get_package_version()},
    )

    return app
