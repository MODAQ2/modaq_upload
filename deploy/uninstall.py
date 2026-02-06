#!/usr/bin/env python3
"""MODAQ Upload - Uninstallation Script.

Run as root: sudo python3 uninstall.py
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

APP_NAME = "modaq-upload"
APP_USER = "modaq"
APP_DIR = Path("/opt/modaq-upload")
LOG_DIR = Path("/var/log/modaq-upload")
SERVICE_FILE = Path("/etc/systemd/system/modaq-upload.service")


def run(cmd: list[str], check: bool = True, **kwargs) -> subprocess.CompletedProcess:
    """Run a command and print it."""
    print(f"  $ {' '.join(cmd)}")
    return subprocess.run(cmd, check=check, **kwargs)


def main() -> int:
    print("=== MODAQ Upload Uninstallation ===\n")

    if os.geteuid() != 0:
        print("Error: This script must be run as root (use sudo)")
        return 1

    # Confirm
    response = input(f"This will remove {APP_NAME} and all its data. Continue? [y/N]: ")
    if response.lower() != "y":
        print("Aborted.")
        return 0

    print()

    # Stop and disable service
    print("Stopping service...")
    run(["systemctl", "stop", APP_NAME], check=False)
    run(["systemctl", "disable", APP_NAME], check=False)
    print()

    # Remove service file
    print("Removing systemd service...")
    if SERVICE_FILE.exists():
        SERVICE_FILE.unlink()
        run(["systemctl", "daemon-reload"])
    print()

    # Remove application directory
    print("Removing application files...")
    if APP_DIR.exists():
        shutil.rmtree(APP_DIR)
        print(f"  Removed: {APP_DIR}")
    if LOG_DIR.exists():
        shutil.rmtree(LOG_DIR)
        print(f"  Removed: {LOG_DIR}")
    print()

    # Remove user (optional)
    print("Removing system user...")
    result = run(["id", APP_USER], check=False, capture_output=True)
    if result.returncode == 0:
        response = input(f"Remove system user '{APP_USER}'? [y/N]: ")
        if response.lower() == "y":
            run(["userdel", APP_USER])
            print(f"  Removed user: {APP_USER}")
        else:
            print(f"  Kept user: {APP_USER}")
    print()

    print("=== Uninstallation Complete ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
