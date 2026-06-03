"""Configuration management for modaq_upload"""

import functools
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import tomllib
import uuid
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

# Base directory for the project
BASE_DIR = Path(__file__).resolve().parent.parent

# Folder name used under the OS-specific application-data location for logs.
APP_DIR_NAME = "modaq_upload"


def get_default_log_directory(app_name: str = APP_DIR_NAME) -> Path:
    """Return the OS-appropriate directory for application logs.

    Follows each platform's conventions for per-user application data so logs
    live in a writable, persistent, standard location instead of inside the
    repository (which breaks when the app is installed read-only or moved):

    - Windows: ``%LOCALAPPDATA%\\<app_name>\\logs``
      (e.g. ``C:\\Users\\you\\AppData\\Local\\modaq_upload\\logs``)
    - macOS:   ``~/Library/Logs/<app_name>``
    - Linux/other POSIX: ``$XDG_STATE_HOME/<app_name>/logs``
      (defaults to ``~/.local/state/<app_name>/logs`` per the XDG Base Directory
      spec, which places logs under "state" data)
    """
    home = Path.home()

    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA")
        root = Path(base) if base else home / "AppData" / "Local"
        return root / app_name / "logs"

    if sys.platform == "darwin":
        return home / "Library" / "Logs" / app_name

    # Linux and other POSIX systems: XDG state directory.
    base = os.environ.get("XDG_STATE_HOME")
    root = Path(base) if base else home / ".local" / "state"
    return root / app_name / "logs"


def _is_under_temp_dir(path: Path) -> bool:
    """True if ``path`` lives inside the OS temp directory.

    A configured log directory under the system temp dir is almost always a
    stale value leaked from a test run (pytest's ``tempfile.mkdtemp``), not a
    real log location — production logs must never be written there.
    """
    try:
        tmp = Path(tempfile.gettempdir()).resolve()
        resolved = path.resolve()
        return resolved == tmp or tmp in resolved.parents
    except OSError:
        return False


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


def _sanitize_partition_value(value: str) -> str:
    """Make a string safe to use as a hive partition value (a path segment).

    Replaces path-hostile characters (slashes, ``=``, and whitespace) with ``-`` so
    the value can't break out of its partition directory or confuse hive parsing.
    Falls back to ``"unknown"`` when the result is empty.
    """
    cleaned = re.sub(r"[/\\=\s]+", "-", value.strip()).strip("-")
    return cleaned or "unknown"


def get_os_name() -> str:
    """Return a partition-safe OS name (e.g. ``Darwin``/``Windows``/``Linux``)."""
    return _sanitize_partition_value(platform.system())


def get_os_version() -> str:
    """Return a partition-safe OS version (e.g. ``25.4.0``).

    Uses ``platform.release()`` for cross-platform uniformity (on macOS this is the
    Darwin kernel version; ``platform.mac_ver()[0]`` would give the product version).
    """
    return _sanitize_partition_value(platform.release())


def get_session_partitions() -> list[str]:
    """Return hive partition segments identifying this install's log session.

    Combines OS, OS version, and a persistent per-install ID so logs from multiple
    machines syncing to one S3 bucket land at distinct, queryable paths.
    """
    return [
        f"os={get_os_name()}",
        f"os_version={get_os_version()}",
        f"session={get_settings().install_id}",
    ]


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
            "log_directory": str(get_default_log_directory()),
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

        # Repair an empty or temp-dir log_directory (e.g. a path leaked from a
        # test run that got persisted to settings.json). Fall back to the
        # OS-standard location so logs never silently write to a temp dir.
        raw_log_dir = str(defaults.get("log_directory") or "").strip()
        resolved_log_dir = (
            Path(raw_log_dir) if Path(raw_log_dir).is_absolute() else BASE_DIR / raw_log_dir
        )
        if not raw_log_dir or _is_under_temp_dir(resolved_log_dir):
            defaults["log_directory"] = str(get_default_log_directory())
            provenance["log_directory"] = {"source": "builtin"}

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
    def install_id(self) -> str:
        """Get a stable per-install identifier, generating and persisting it once.

        Stored in the gitignored settings.json so it survives restarts and stays
        unique per machine. Used to give each install's logs a distinct S3 path.
        """
        existing = self._settings.get("install_id")
        if existing:
            return str(existing)
        new_id = uuid.uuid4().hex[:12]
        self.set("install_id", new_id)
        return new_id

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

    def _get_remote_version(self) -> str | None:
        """Read the version from the remote pyproject.toml (FETCH_HEAD)."""
        try:
            result = subprocess.run(
                ["git", "show", "FETCH_HEAD:pyproject.toml"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )
            for line in result.stdout.splitlines():
                stripped = line.strip()
                if stripped.startswith("version") and "=" in stripped:
                    raw = stripped.split("=", 1)[1].strip().strip('"').strip("'")
                    return raw
        except Exception:
            pass
        return None

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

            # Check how many commits behind we are
            behind_result = subprocess.run(
                ["git", "rev-list", "--count", "HEAD..@{u}"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
            )
            commits_behind = 0
            if behind_result.returncode == 0:
                try:
                    commits_behind = int(behind_result.stdout.strip())
                except ValueError:
                    commits_behind = 0

            # Check if we're behind remote
            status_result = subprocess.run(
                ["git", "status", "-uno"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )

            behind = commits_behind > 0
            up_to_date = "Your branch is up to date" in status_result.stdout

            # Get current commit
            current = subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )

            # Get remote commit
            remote_commit_result = subprocess.run(
                ["git", "rev-parse", "--short", "@{u}"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
            )
            remote_commit = (
                remote_commit_result.stdout.strip()
                if remote_commit_result.returncode == 0
                else None
            )

            # Try to read the remote version from pyproject.toml
            remote_version = self._get_remote_version() if behind else None

            return {
                "updates_available": behind,
                "up_to_date": up_to_date,
                "current_commit": current.stdout.strip(),
                "remote_commit": remote_commit,
                "commits_behind": commits_behind,
                "remote_version": remote_version,
                "error": None,
            }
        except subprocess.CalledProcessError as e:
            return {
                "updates_available": False,
                "up_to_date": False,
                "current_commit": None,
                "remote_commit": None,
                "commits_behind": 0,
                "remote_version": None,
                "error": str(e),
            }

    # Human-readable labels for each update step
    STEP_LABELS: dict[str, str] = {
        "git_pull": "Downloading update",
        "pip_install": "Installing Python packages",
        "modaq_toolkit": "Updating data tools",
        "npm_install": "Installing app dependencies",
        "frontend_build": "Rebuilding interface",
    }

    def update_application(self) -> dict[str, Any]:
        """Pull latest changes from git and reinstall dependencies.

        Saves the pre-update commit so the caller can offer rollback on failure.
        """
        # Capture the current commit so we can roll back if needed
        pre_update_commit: str | None = None
        try:
            cp = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )
            pre_update_commit = cp.stdout.strip()
        except subprocess.CalledProcessError:
            pass

        step_order = ["git_pull", "pip_install", "modaq_toolkit", "npm_install", "frontend_build"]
        results: dict[str, Any] = {
            name: {"success": False, "output": "", "label": self.STEP_LABELS.get(name, name)}
            for name in step_order
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

        failed_at: str | None = None
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
                    "label": self.STEP_LABELS.get(step_name, step_name),
                }
            except subprocess.CalledProcessError as e:
                results[step_name] = {
                    "success": False,
                    "output": e.stdout + e.stderr if (e.stdout or e.stderr) else str(e),
                    "label": self.STEP_LABELS.get(step_name, step_name),
                }
                failed_at = step_name
                break

        all_success = failed_at is None
        return {
            "results": results,
            "step_order": step_order,
            "success": all_success,
            "failed_at": failed_at,
            "pre_update_commit": pre_update_commit,
        }

    def rollback_update(self, commit: str) -> dict[str, Any]:
        """Roll back to a specific git commit and rebuild the frontend."""
        try:
            # Hard-reset to the saved commit
            subprocess.run(
                ["git", "reset", "--hard", commit],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )
        except subprocess.CalledProcessError as e:
            return {
                "success": False,
                "output": e.stdout + e.stderr if (e.stdout or e.stderr) else str(e),
                "error": "Failed to reset git repository",
            }

        # Rebuild the frontend so the rolled-back version is served correctly
        frontend_dir = str(self.base_dir / "frontend")
        build_output = ""
        try:
            result = subprocess.run(
                ["npm", "run", "build"],
                cwd=frontend_dir,
                capture_output=True,
                text=True,
                check=True,
            )
            build_output = result.stdout + result.stderr
        except subprocess.CalledProcessError as e:
            build_output = e.stdout + e.stderr if (e.stdout or e.stderr) else str(e)

        return {
            "success": True,
            "commit": commit,
            "output": build_output,
            "error": None,
        }

    def get_branches(self) -> dict[str, Any]:
        """Get current branch and list of all local and remote branches."""
        try:
            current = subprocess.run(
                ["git", "branch", "--show-current"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )

            local = subprocess.run(
                ["git", "branch", "--format=%(refname:short)"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )

            remote = subprocess.run(
                ["git", "branch", "-r", "--format=%(refname:short)"],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )

            local_branches = [b.strip() for b in local.stdout.splitlines() if b.strip()]
            # Strip "origin/" prefix and de-duplicate with local branches
            remote_branches = [
                b.strip().removeprefix("origin/")
                for b in remote.stdout.splitlines()
                if b.strip() and "HEAD" not in b and b.strip() != "origin"
            ]
            all_branches = sorted(set(local_branches + remote_branches))

            return {
                "current": current.stdout.strip(),
                "branches": all_branches,
                "error": None,
            }
        except subprocess.CalledProcessError as e:
            return {
                "current": None,
                "branches": [],
                "error": str(e),
            }

    def switch_branch(self, branch: str) -> dict[str, Any]:
        """Switch to the specified git branch."""
        try:
            result = subprocess.run(
                ["git", "checkout", branch],
                cwd=self.base_dir,
                capture_output=True,
                text=True,
                check=True,
            )
            return {
                "success": True,
                "branch": branch,
                "output": result.stdout + result.stderr,
                "error": None,
            }
        except subprocess.CalledProcessError as e:
            return {
                "success": False,
                "branch": branch,
                "output": e.stdout + e.stderr if e.stdout or e.stderr else "",
                "error": str(e),
            }

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
