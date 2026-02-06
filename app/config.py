"""Configuration management for modaq_upload"""

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


def get_package_version() -> str:
    """Get the package version from pyproject.toml."""
    try:
        with open(PYPROJECT_FILE, "rb") as f:
            pyproject = tomllib.load(f)
        return str(pyproject.get("project", {}).get("version", "0.0.0"))
    except Exception:
        return "0.0.0"


def get_package_name() -> str:
    """Get the package name from pyproject.toml."""
    try:
        with open(PYPROJECT_FILE, "rb") as f:
            pyproject = tomllib.load(f)
        return str(pyproject.get("project", {}).get("name", "modaq-uploader"))
    except Exception:
        return "modaq-uploader"


class Settings:
    """Manages application settings stored in JSON format."""

    _instance: "Settings | None" = None
    _settings: dict[str, Any]

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
        }

        # Load from settings.default.json if it exists
        if SETTINGS_DEFAULT_FILE.exists():
            with open(SETTINGS_DEFAULT_FILE, encoding="utf-8") as f:
                defaults.update(json.load(f))

        # Load from settings.json if it exists
        if SETTINGS_FILE.exists():
            with open(SETTINGS_FILE, encoding="utf-8") as f:
                defaults.update(json.load(f))

        # Override with environment variables (highest priority)
        env_overrides = {
            "aws_profile": os.environ.get(ENV_AWS_PROFILE),
            "aws_region": os.environ.get(ENV_AWS_REGION),
            "s3_bucket": os.environ.get(ENV_S3_BUCKET),
            "default_upload_folder": os.environ.get(ENV_DEFAULT_UPLOAD_FOLDER),
        }

        # Only apply non-None environment values
        for key, value in env_overrides.items():
            if value is not None:
                defaults[key] = value

        self._settings = defaults

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

    def reload(self) -> None:
        """Reload settings from file."""
        self._load_settings()

    @property
    def aws_profile(self) -> str:
        """Get the AWS profile name."""
        return str(self._settings.get("aws_profile", "default"))

    @property
    def aws_region(self) -> str:
        """Get the AWS region."""
        return str(self._settings.get("aws_region", "us-west-2"))

    @property
    def s3_bucket(self) -> str:
        """Get the S3 bucket name."""
        return str(self._settings.get("s3_bucket", ""))

    @property
    def default_upload_folder(self) -> str:
        """Get the default upload folder path."""
        return str(self._settings.get("default_upload_folder", ""))


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
        }

        try:
            # Git pull
            git_result = subprocess.run(
                ["git", "pull"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )
            results["git_pull"] = {
                "success": True,
                "output": git_result.stdout + git_result.stderr,
            }

            # Pip install requirements
            pip_result = subprocess.run(
                [sys.executable, "-m", "pip", "install", "-r", "requirements.txt"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )
            results["pip_install"] = {
                "success": True,
                "output": pip_result.stdout + pip_result.stderr,
            }

            # Update modaq_toolkit specifically (force reinstall to get latest)
            modaq_result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "--upgrade",
                    "--force-reinstall",
                    "git+https://github.com/MODAQ2/MODAQ_toolkit.git",
                ],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )
            results["modaq_toolkit"] = {
                "success": True,
                "output": modaq_result.stdout + modaq_result.stderr,
            }

        except subprocess.CalledProcessError as e:
            # Record which step failed
            cmd_name = " ".join(e.cmd) if isinstance(e.cmd, list) else str(e.cmd)
            if "git" in cmd_name:
                results["git_pull"] = {
                    "success": False,
                    "output": e.stdout + e.stderr if e.stdout else str(e),
                }
            elif "modaq" in cmd_name.lower() or "MODAQ" in cmd_name:
                results["modaq_toolkit"] = {
                    "success": False,
                    "output": e.stdout + e.stderr if e.stdout else str(e),
                }
            else:
                results["pip_install"] = {
                    "success": False,
                    "output": e.stdout + e.stderr if e.stdout else str(e),
                }

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
