#!/usr/bin/env python3
"""MODAQ Upload - Production Installation Script.

Run as root: sudo python3 install.py
"""

import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

# Configuration
APP_NAME = "modaq-upload"
APP_USER = "modaq"
APP_DIR = Path("/opt/modaq-upload")
LOG_DIR = Path("/var/log/modaq-upload")
SCRIPT_DIR = Path(__file__).parent.resolve()
PROJECT_DIR = SCRIPT_DIR.parent

PYTHON_MAJOR = 3
PYTHON_MINOR = 11
PYTHON_VERSION = f"python{PYTHON_MAJOR}.{PYTHON_MINOR}"


def run(cmd: list[str] | str, check: bool = True, **kwargs) -> subprocess.CompletedProcess:
    """Run a command and print it."""
    if isinstance(cmd, str):
        print(f"  $ {cmd}")
        return subprocess.run(cmd, shell=True, check=check, **kwargs)
    print(f"  $ {' '.join(cmd)}")
    return subprocess.run(cmd, check=check, **kwargs)


def user_exists(username: str) -> bool:
    """Check if a system user exists."""
    result = run(["id", username], check=False, capture_output=True)
    return result.returncode == 0


def detect_package_manager() -> tuple[str, list[str]]:
    """Detect the system package manager."""
    if shutil.which("apt-get"):
        return "apt", ["apt-get", "install", "-y"]
    elif shutil.which("dnf"):
        return "dnf", ["dnf", "install", "-y"]
    elif shutil.which("yum"):
        return "yum", ["yum", "install", "-y"]
    else:
        raise RuntimeError("No supported package manager found (apt, dnf, yum)")


def main() -> int:
    print("=== MODAQ Upload Production Installation ===\n")

    # Check if running as root
    if os.geteuid() != 0:
        print("Error: This script must be run as root (use sudo)")
        return 1

    # Detect package manager
    pkg_name, pkg_install = detect_package_manager()
    print(f"Detected package manager: {pkg_name}\n")

    print("Installing system dependencies...")
    if pkg_name == "apt":
        run(["apt-get", "update"])
        packages = [PYTHON_VERSION, f"{PYTHON_VERSION}-venv", "git"]
    elif pkg_name in ("dnf", "yum"):
        packages = [PYTHON_VERSION, f"{PYTHON_VERSION}-pip", "git"]
    else:
        packages = [PYTHON_VERSION, "git"]
    run(pkg_install + packages)
    print()

    # Verify Python 3.11 is available
    python_bin = shutil.which(PYTHON_VERSION)
    if python_bin is None:
        print(f"Error: {PYTHON_VERSION} not found after install. Install it manually and retry.")
        return 1
    print(f"Using Python: {python_bin}")

    print("Creating application user...")
    if not user_exists(APP_USER):
        run(["useradd", "--system", "--shell", "/bin/false", "--home-dir", str(APP_DIR), APP_USER])
        print(f"  Created user: {APP_USER}")
    else:
        print(f"  User {APP_USER} already exists")
    print()

    print("Setting up application directory...")
    APP_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    # Copy application files from local directory
    files_to_copy = [
        ("app", True),  # (name, is_directory)
        ("wsgi.py", False),
        ("pyproject.toml", False),
        ("requirements.txt", False),
        ("settings.default.json", False),
    ]

    for name, is_dir in files_to_copy:
        src = PROJECT_DIR / name
        dst = APP_DIR / name
        if src.exists():
            if is_dir:
                if dst.exists():
                    shutil.rmtree(dst)
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
            print(f"  Copied: {name}")
    print()

    # Create Python virtual environment with 3.11
    print("Creating Python virtual environment...")
    venv_dir = APP_DIR / "venv"
    run([python_bin, "-m", "venv", str(venv_dir)])
    print()

    # Install Python dependencies
    print("Installing Python dependencies...")
    pip = venv_dir / "bin" / "pip"
    run([str(pip), "install", "--upgrade", "pip"])
    run([str(pip), "install", "-r", str(APP_DIR / "requirements.txt")])
    print()

    # Create settings.json if it doesn't exist
    print("Configuring application...")
    settings_file = APP_DIR / "settings.json"
    settings_default = APP_DIR / "settings.default.json"
    if not settings_file.exists() and settings_default.exists():
        shutil.copy2(settings_default, settings_file)
        print("  Created settings.json from defaults")

    # Generate SECRET_KEY in .env if it doesn't already exist
    env_file = APP_DIR / ".env"
    if not env_file.exists():
        secret_key = secrets.token_hex(32)
        env_file.write_text(f"SECRET_KEY={secret_key}\n")
        print("  Generated SECRET_KEY in .env")
    else:
        print("  .env already exists, keeping existing SECRET_KEY")
    print()

    # 6: Set permissions
    print("Setting permissions...")
    run(["chown", "-R", f"{APP_USER}:{APP_USER}", str(APP_DIR)])
    run(["chown", "-R", f"{APP_USER}:{APP_USER}", str(LOG_DIR)])
    run(["chmod", "750", str(APP_DIR)])
    run(["chmod", "750", str(LOG_DIR)])
    if settings_file.exists():
        run(["chmod", "640", str(settings_file)])
    if env_file.exists():
        run(["chmod", "640", str(env_file)])
    print()

    # Install systemd service
    print("Installing systemd service...")
    service_src = SCRIPT_DIR / "modaq-upload.service"
    service_dst = Path("/etc/systemd/system/modaq-upload.service")
    shutil.copy2(service_src, service_dst)
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", APP_NAME])
    run(["systemctl", "start", APP_NAME])
    print()

    # Final status
    print("=== Installation Complete ===\n")
    print("Service status:")
    run(["systemctl", "status", APP_NAME, "--no-pager"], check=False)

    print(f"""
Useful commands:
  sudo systemctl status {APP_NAME}    # Check status
  sudo systemctl restart {APP_NAME}   # Restart service
  sudo systemctl stop {APP_NAME}      # Stop service
  sudo journalctl -u {APP_NAME} -f    # View logs

Application URL: http://localhost:8080
Log files: {LOG_DIR}/

Next steps:
  1. Configure AWS credentials for the '{APP_USER}' user:
     sudo -u {APP_USER} aws configure --profile default
  2. Edit {APP_DIR}/settings.json with your S3 bucket
""")

    return 0


if __name__ == "__main__":
    sys.exit(main())
