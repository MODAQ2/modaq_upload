"""Flask application factory for MCAP S3 Uploader."""

import os

from flask import Flask

from app.config import get_package_version, get_settings


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
