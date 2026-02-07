#!/usr/bin/env python3
"""Install MODAQ Upload desktop entry for Linux.

Creates a .desktop file so MODAQ Upload appears in your
application launcher with an icon.
"""

import os
import shutil
import stat
import subprocess
import sys

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_FILE = os.path.join(PROJECT_DIR, "modaq-upload.desktop.template")
DESKTOP_DIR = os.path.join(os.path.expanduser("~"), ".local", "share", "applications")
DESKTOP_FILE = os.path.join(DESKTOP_DIR, "modaq-upload.desktop")
LAUNCH_SCRIPT = os.path.join(PROJECT_DIR, "launch.py")


def main() -> None:
    print("[MODAQ] Installing desktop entry...")

    # Read template
    if not os.path.isfile(TEMPLATE_FILE):
        print(f"[MODAQ] Error: Template not found at {TEMPLATE_FILE}")
        sys.exit(1)

    with open(TEMPLATE_FILE) as f:
        content = f.read()

    # Substitute paths
    content = content.replace("{{PROJECT_DIR}}", PROJECT_DIR)

    # Ensure target directory exists
    os.makedirs(DESKTOP_DIR, exist_ok=True)

    # Write .desktop file
    with open(DESKTOP_FILE, "w") as f:
        f.write(content)

    # Make files executable
    for path in (DESKTOP_FILE, LAUNCH_SCRIPT):
        st = os.stat(path)
        os.chmod(path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    # Update desktop database if available
    if shutil.which("update-desktop-database"):
        subprocess.run(
            ["update-desktop-database", DESKTOP_DIR],
            capture_output=True,
        )

    print(f"[MODAQ] Desktop entry installed to: {DESKTOP_FILE}")
    print("[MODAQ] You should now see 'MODAQ Upload' in your application launcher.")
    print(f"[MODAQ] You can also run directly with: python3 {LAUNCH_SCRIPT}")


if __name__ == "__main__":
    main()
