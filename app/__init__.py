"""Flask application factory for MCAP S3 Uploader."""

import atexit
import os
import threading

from flask import Flask

from app.config import get_package_version, get_settings

# Background cleanup thread control
_cleanup_thread: threading.Thread | None = None
_cleanup_stop_event = threading.Event()


def _sse_cleanup_worker() -> None:
    """Background worker that periodically cleans up stale SSE queues."""
    from app.routes.upload import _cleanup_old_sse_queues

    while not _cleanup_stop_event.wait(timeout=300):  # Check every 5 minutes
        try:
            removed = _cleanup_old_sse_queues()
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

    # Start background SSE cleanup thread
    _start_sse_cleanup()

    # Register cleanup on shutdown
    atexit.register(_stop_sse_cleanup)

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
