"""Configuration management for modaq_upload"""

import functools
import json
import os
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

# Base directory for the project
BASE_DIR = Path(__file__).resolve().parent.parent

# Load environment variables from .env file
ENV_FILE = BASE_DIR / ".env"
load_dotenv(ENV_FILE)

# Settings file paths
SETTINGS_FILE = BASE_DIR / "settings.json"
SETTINGS_DEFAULT_FILE = BASE_DIR / "settings.default.json"
PYPROJECT_FILE = BASE_DIR / "pyproject.toml"

# Environment variable names for configuration
ENV_AWS_PROFILE = "MODAQ_AWS_PROFILE"
ENV_AWS_REGION = "MODAQ_AWS_REGION"
ENV_S3_BUCKET = "MODAQ_S3_BUCKET"
ENV_DEFAULT_UPLOAD_FOLDER = "MODAQ_DEFAULT_UPLOAD_FOLDER"
ENV_DISPLAY_NAME = "MODAQ_DISPLAY_NAME"
ENV_LOG_DIRECTORY = "MODAQ_LOG_DIRECTORY"
ENV_ALLOWED_EXTENSIONS = "MODAQ_ALLOWED_EXTENSIONS"


@functools.cache
def _read_pyproject_field(field: str, default: str) -> str:
    """Read a field from pyproject.toml [project] section (cached)."""
    try:
        with open(PYPROJECT_FILE, "rb") as f:
            pyproject = tomllib.load(f)
        return str(pyproject.get("project", {}).get(field, default))
    except Exception:
        return default


def get_package_version() -> str:
    """Get the package version from pyproject.toml."""
    return _read_pyproject_field("version", "0.0.0")


def get_package_name() -> str:
    """Get the package name from pyproject.toml."""
    return _read_pyproject_field("name", "modaq-uploader")


class Settings:
    """Manages application settings stored in JSON format."""

    _instance: "Settings | None" = None
    _settings: dict[str, Any]
    _provenance: dict[str, dict[str, str]]

    def __new__(cls) -> "Settings":
        """Singleton pattern to ensure only one settings instance exists."""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._load_settings()
        return cls._instance

    def _load_settings(self) -> None:
        """Load settings from file, with environment variables taking precedence.

        Priority order (highest to lowest):
        1. Environment variables (from .env file or system)
        2. settings.json (user-saved settings)
        3. settings.default.json (template defaults)
        4. Hardcoded defaults
        """
        # Start with hardcoded defaults
        defaults = {
            "aws_profile": "default",
            "aws_region": "us-west-2",
            "s3_bucket": "",
            "default_upload_folder": "",
            "display_name": "MODAQ Uploader",
            "log_directory": "logs",
            "file_categories": [
                {
                    "name": "data",
                    "extensions": ["mcap", "tdms", "done", "csv"],
                    "partition_interval": "10min",
                    "description": "High-frequency data files",
                },
                {
                    "name": "logs",
                    "extensions": ["txt", "log", "yaml", "logs"],
                    "partition_interval": "daily",
                    "description": "System and operation logs",
                },
            ],
            "batch_processing": {
                "enabled": True,
                "batch_size": 100,
                "auto_tune_workers": True,
                "max_workers": 4,
                "target_cpu_percent": 70.0,
                "skip_mcap_validation": False,
                "use_database_for_large_jobs": True,
                "large_job_threshold": 1000,
            },
        }

        # Track the source of each setting value as it is applied layer by layer.
        provenance: dict[str, dict[str, str]] = {k: {"source": "builtin"} for k in defaults}

        # Load from settings.default.json if it exists
        if SETTINGS_DEFAULT_FILE.exists():
            with open(SETTINGS_DEFAULT_FILE, encoding="utf-8") as f:
                default_data = json.load(f)
            defaults.update(default_data)
            for k in default_data:
                provenance[k] = {"source": "default_file", "path": str(SETTINGS_DEFAULT_FILE)}

        # Load from settings.json if it exists
        if SETTINGS_FILE.exists():
            with open(SETTINGS_FILE, encoding="utf-8") as f:
                user_data = json.load(f)
            defaults.update(user_data)
            for k in user_data:
                provenance[k] = {"source": "settings_file", "path": str(SETTINGS_FILE)}

        # Override with environment variables (highest priority)
        env_overrides: dict[str, tuple[str | None, str]] = {
            "aws_profile": (os.environ.get(ENV_AWS_PROFILE), ENV_AWS_PROFILE),
            "aws_region": (os.environ.get(ENV_AWS_REGION), ENV_AWS_REGION),
            "s3_bucket": (os.environ.get(ENV_S3_BUCKET), ENV_S3_BUCKET),
            "default_upload_folder": (
                os.environ.get(ENV_DEFAULT_UPLOAD_FOLDER),
                ENV_DEFAULT_UPLOAD_FOLDER,
            ),
            "display_name": (os.environ.get(ENV_DISPLAY_NAME), ENV_DISPLAY_NAME),
            "log_directory": (os.environ.get(ENV_LOG_DIRECTORY), ENV_LOG_DIRECTORY),
        }

        # Only apply non-None environment values
        for key, (value, env_var) in env_overrides.items():
            if value is not None:
                defaults[key] = value
                provenance[key] = {"source": "env", "env_var": env_var}

        self._settings = defaults
        self._provenance = provenance

        # Save settings.json if it doesn't exist
        if not SETTINGS_FILE.exists():
            self._save_settings()

    def _save_settings(self) -> None:
        """Save current settings to file."""
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(self._settings, f, indent=4)

    def get(self, key: str, default: Any = None) -> Any:
        """Get a setting value by key."""
        return self._settings.get(key, default)

    def set(self, key: str, value: Any) -> None:
        """Set a setting value and save to file."""
        self._settings[key] = value
        self._save_settings()

    def update(self, data: dict[str, Any]) -> None:
        """Update multiple settings at once."""
        self._settings.update(data)
        self._save_settings()

    def all(self) -> dict[str, Any]:
        """Get all settings as a dictionary."""
        return self._settings.copy()

    def to_response(self) -> dict[str, Any]:
        """Return settings with value_sources provenance for API responses."""
        return {**self._settings, "value_sources": self._provenance}

    def reload(self) -> None:
        """Reload settings from file."""
        self._load_settings()

    @property
    def aws_profile(self) -> str:
        """Get the AWS profile name."""
        return str(self._settings["aws_profile"])

    @property
    def aws_region(self) -> str:
        """Get the AWS region."""
        return str(self._settings["aws_region"])

    @property
    def s3_bucket(self) -> str:
        """Get the S3 bucket name."""
        return str(self._settings["s3_bucket"])

    @property
    def default_upload_folder(self) -> str:
        """Get the default upload folder path."""
        return str(self._settings["default_upload_folder"])

    @property
    def display_name(self) -> str:
        """Get the display name for the application."""
        return str(self._settings["display_name"])

    @property
    def log_directory(self) -> Path:
        """Get the log directory path (resolved to absolute path relative to BASE_DIR)."""
        log_dir = str(self._settings["log_directory"])
        path = Path(log_dir)
        if not path.is_absolute():
            path = BASE_DIR / path
        return path

    @property
    def file_categories(self) -> list[dict[str, Any]]:
        """Get the list of file categories."""
        return list(self._settings.get("file_categories", []))

    @property
    def allowed_extensions(self) -> list[str]:
        """Get the flat list of allowed file extensions (lowercase, no dot).

        Aggregates extensions from all file_categories.
        """
        categories = self.file_categories
        all_exts = set()
        for cat in categories:
            for ext in cat.get("extensions", []):
                all_exts.add(str(ext).lower().lstrip("."))
        return sorted(list(all_exts))

    @property
    def batch_processing(self) -> dict[str, Any]:
        """Get batch processing configuration."""
        return dict(self._settings.get("batch_processing", {}))

    def get_batch_config(self) -> dict[str, Any]:
        """Get batch processing configuration (alias for batch_processing property)."""
        return self.batch_processing


def get_settings() -> Settings:
    """Get the singleton Settings instance."""
    return Settings()


class AppUpdater:
    """Handles application updates via git and pip."""

    def __init__(self) -> None:
        self.base_dir = BASE_DIR

    def check_for_updates(self) -> dict[str, Any]:
        """Check if there are updates available from git remote."""
        try:
            # Fetch from remote
            subprocess.run(
                ["git", "fetch"],
                cwd=self.base_dir,
                capture_output=True,
                check=True,
            )

            # Check if we're behind remote
            result = subprocess.run(
                ["git", "status", "-uno"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )

            behind = "Your branch is behind" in result.stdout
            up_to_date = "Your branch is up to date" in result.stdout

            # Get current commit
            current = subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )

            return {
                "updates_available": behind,
                "up_to_date": up_to_date,
                "current_commit": current.stdout.strip(),
                "error": None,
            }
        except subprocess.CalledProcessError as e:
            return {
                "updates_available": False,
                "up_to_date": False,
                "current_commit": None,
                "error": str(e),
            }

    def update_application(self) -> dict[str, Any]:
        """Pull latest changes from git and reinstall dependencies."""
        results: dict[str, Any] = {
            "git_pull": {"success": False, "output": ""},
            "pip_install": {"success": False, "output": ""},
            "modaq_toolkit": {"success": False, "output": ""},
            "npm_install": {"success": False, "output": ""},
            "frontend_build": {"success": False, "output": ""},
        }

        frontend_dir = str(self.base_dir / "frontend")

        steps: list[tuple[str, list[str], str | None]] = [
            ("git_pull", ["git", "pull"], None),
            (
                "pip_install",
                [sys.executable, "-m", "pip", "install", "-r", "requirements.txt"],
                None,
            ),
            (
                "modaq_toolkit",
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "--upgrade",
                    "--force-reinstall",
                    "git+https://github.com/MODAQ2/MODAQ_toolkit.git",
                ],
                None,
            ),
            ("npm_install", ["npm", "install"], frontend_dir),
            ("frontend_build", ["npm", "run", "build"], frontend_dir),
        ]

        for step_name, cmd, cwd in steps:
            try:
                result = subprocess.run(
                    cmd,
                    cwd=cwd or self.base_dir,
                    capture_output=True,
                    text=True,
                    check=True,
                )
                results[step_name] = {
                    "success": True,
                    "output": result.stdout + result.stderr,
                }
            except subprocess.CalledProcessError as e:
                results[step_name] = {
                    "success": False,
                    "output": e.stdout + e.stderr if e.stdout else str(e),
                }
                break

        return results

    def get_version_info(self) -> dict[str, Any]:
        """Get current version information."""
        try:
            # Get git commit hash
            commit = subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )

            # Get git branch
            branch = subprocess.run(
                ["git", "branch", "--show-current"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )

            # Get last commit date
            date = subprocess.run(
                ["git", "log", "-1", "--format=%ci"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )

            return {
                "commit": commit.stdout.strip(),
                "branch": branch.stdout.strip(),
                "last_updated": date.stdout.strip(),
                "error": None,
            }
        except subprocess.CalledProcessError as e:
            return {
                "commit": None,
                "branch": None,
                "last_updated": None,
                "error": str(e),
            }


def get_updater() -> AppUpdater:
    """Get an AppUpdater instance."""
    return AppUpdater()
