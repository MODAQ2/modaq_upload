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
from app.config import SETTINGS_FILE


@pytest.fixture
def app() -> Generator[Flask, None, None]:
    """Create application for testing."""
    # Use a temporary settings file
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(
            {
                "aws_profile": "default",
                "aws_region": "us-west-2",
                "s3_bucket": "test-bucket",
                "default_upload_folder": "",
            },
            f,
        )
        temp_settings = f.name

    # Create the app (settings will be loaded from default)
    _ = SETTINGS_FILE  # Reference to avoid unused import warning

    app = create_app()
    app.config["TESTING"] = True

    yield app

    # Cleanup
    os.unlink(temp_settings)


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
