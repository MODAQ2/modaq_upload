"""WSGI entry point for production deployment (gunicorn)."""

from app import create_app

app = create_app()
