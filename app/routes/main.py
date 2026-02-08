"""Main page routes for modaq_upload"""

from flask import Blueprint, render_template

main_bp = Blueprint("main", __name__)


@main_bp.route("/")
def index() -> str:
    """Render the upload page."""
    return render_template("index.html")


@main_bp.route("/files")
def files() -> str:
    """Render the S3 file browser page."""
    return render_template("files.html")


@main_bp.route("/settings")
def settings() -> str:
    """Render the settings page."""
    return render_template("settings.html")


@main_bp.route("/logs")
def logs() -> str:
    """Render the logs viewer page."""
    return render_template("logs.html")
