"""Pytest configuration and fixtures for the modaq_upload tests."""

import json
import os
import tempfile
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient

from app import create_app


@pytest.fixture(autouse=True)
def _reset_s3_client_cache() -> Generator[None, None, None]:
    """Clear the cached S3 client around every test.

    The cache persists module-level, so without this a client built under one
    test's ``mock_aws`` context (or with one profile) would leak into the next.
    """
    from app.services import s3_service

    s3_service.reset_s3_client_cache()
    yield
    s3_service.reset_s3_client_cache()


@pytest.fixture
def app() -> Generator[Flask, None, None]:
    """Create application for testing."""
    import app.config as config

    # Isolate settings: copy the committed settings.test.json template to a
    # throwaway file, point SETTINGS_FILE at the copy, and reset the singleton so
    # the app reads/writes there. Without this, tests that save settings (e.g.
    # PUT /api/settings) would clobber the real, gitignored settings.json. We copy
    # rather than use the template directly so saves never mutate the template.
    test_template = config.BASE_DIR / "settings.test.json"
    settings_seed = json.loads(test_template.read_text(encoding="utf-8"))
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(settings_seed, f)
        temp_settings = f.name

    # Ensure frontend/dist/index.html exists so SPA routes can serve it
    from app.routes.main import FRONTEND_DIST

    dist_created = False
    index_path = os.path.join(FRONTEND_DIST, "index.html")
    if not os.path.exists(index_path):
        os.makedirs(FRONTEND_DIST, exist_ok=True)
        dist_created = True
        with open(index_path, "w") as f:
            f.write('<!doctype html><html><body><div id="root"></div></body></html>')

    original_settings_file = config.SETTINGS_FILE
    original_instance = config.Settings._instance
    config.SETTINGS_FILE = Path(temp_settings)
    config.Settings._instance = None  # force a reload from the temp settings file

    # Redirect logs to a temp dir so the automatic request/error logging hooks
    # don't write into the repo's real logs/ directory during tests.
    from app.config import get_settings

    settings = get_settings()
    log_temp_dir = tempfile.mkdtemp()
    settings._settings["log_directory"] = log_temp_dir

    app = create_app()
    app.config["TESTING"] = True

    yield app

    # Cleanup: restore the real settings file path and singleton.
    config.SETTINGS_FILE = original_settings_file
    config.Settings._instance = original_instance
    os.unlink(temp_settings)
    if dist_created:
        os.unlink(index_path)


@pytest.fixture
def client(app: Flask) -> FlaskClient:
    """Create test client."""
    return app.test_client()


@pytest.fixture
def temp_mcap_file() -> Generator[Path, None, None]:
    """Create a temporary file to simulate an MCAP file.

    Note: This creates a dummy file, not a real MCAP file.
    For real MCAP testing, use actual test files from SURF-WEC data.
    """
    with tempfile.NamedTemporaryFile(mode="wb", suffix=".mcap", delete=False) as f:
        # Write some dummy content
        f.write(b"MCAP0" + b"\x00" * 100)
        temp_path = Path(f.name)

    yield temp_path

    # Cleanup
    if temp_path.exists():
        temp_path.unlink()


@pytest.fixture
def temp_files() -> Generator[list[Path], None, None]:
    """Create multiple temporary files for testing."""
    files: list[Path] = []
    temp_dir = tempfile.mkdtemp()

    for i in range(3):
        path = Path(temp_dir) / f"test_file_{i}.mcap"
        path.write_bytes(b"MCAP0" + b"\x00" * (100 * (i + 1)))
        files.append(path)

    yield files

    # Cleanup
    for f in files:
        if f.exists():
            f.unlink()
    os.rmdir(temp_dir)


@pytest.fixture
def mock_settings() -> dict[str, Any]:
    """Return mock settings for testing."""
    return {
        "aws_profile": "test-profile",
        "aws_region": "us-west-2",
        "s3_bucket": "test-bucket",
        "default_upload_folder": "/tmp/test",
    }


@pytest.fixture
def sample_timestamps() -> list[tuple[int, int, str]]:
    """Return sample timestamps for S3 path generation testing.

    Returns list of (minute, expected_bucket, description) tuples.
    """
    return [
        (0, 0, "Start of hour"),
        (5, 0, "Within first bucket"),
        (10, 10, "Exactly on bucket boundary"),
        (15, 10, "Within second bucket"),
        (25, 20, "Within third bucket"),
        (35, 30, "Within fourth bucket"),
        (45, 40, "Within fifth bucket"),
        (55, 50, "Within last bucket"),
        (59, 50, "End of hour"),
    ]
