"""Main page routes for modaq_upload — serves the React SPA."""

import os

from flask import Blueprint, Response, send_from_directory

main_bp = Blueprint("main", __name__)

# Path to the React production build
FRONTEND_DIST = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "frontend",
    "dist",
)


@main_bp.route("/")
@main_bp.route("/delete")
@main_bp.route("/files")
@main_bp.route("/settings")
@main_bp.route("/logs")
def serve_spa() -> Response:
    """Serve React's index.html for all client-side routes."""
    return send_from_directory(FRONTEND_DIST, "index.html")


@main_bp.route("/assets/<path:filename>")
def serve_assets(filename: str) -> Response:
    """Serve Vite-built static assets (JS, CSS)."""
    return send_from_directory(os.path.join(FRONTEND_DIST, "assets"), filename)


@main_bp.route("/images/<path:filename>")
def serve_images(filename: str) -> Response:
    """Serve image assets from the public directory."""
    return send_from_directory(os.path.join(FRONTEND_DIST, "images"), filename)
