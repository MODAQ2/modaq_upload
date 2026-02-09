#!/usr/bin/env python3
"""MODAQ Upload Launcher.

Starts gunicorn and opens Firefox to modaq-upload.localhost.
"""

import os
import signal
import subprocess
import sys
import time
import urllib.request

# ── Configuration ────────────────────────────────────────────
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
VENV_DIR = os.path.join(PROJECT_DIR, "venv")
PORT = 5000
BROWSER_URL = f"http://modaq-upload.localhost:{PORT}"
HEALTH_URL = f"http://127.0.0.1:{PORT}"
PID_FILE = os.path.join(PROJECT_DIR, ".gunicorn.pid")

gunicorn_proc: subprocess.Popen | None = None


def log(msg: str) -> None:
    print(f"[MODAQ] {msg}", flush=True)


def port_in_use(port: int) -> bool:
    """Check if a port is already in use."""
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def open_browser(url: str) -> None:
    """Open URL in Firefox, falling back to xdg-open."""
    import shutil

    if shutil.which("firefox"):
        subprocess.Popen(
            ["firefox", url],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
    elif shutil.which("xdg-open"):
        subprocess.Popen(
            ["xdg-open", url],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
    else:
        log(f"Could not find a browser. Open {url} manually.")


def wait_for_server(timeout: int = 15) -> bool:
    """Poll the health URL until the server responds or timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(HEALTH_URL, timeout=1)
            return True
        except Exception:
            pass
        # Check if gunicorn died
        if gunicorn_proc and gunicorn_proc.poll() is not None:
            return False
        time.sleep(0.5)
    return False


def shutdown(_signum: int = 0, _frame: object = None) -> None:
    """Gracefully stop gunicorn."""
    print()
    log("Shutting down...")
    if gunicorn_proc and gunicorn_proc.poll() is None:
        gunicorn_proc.terminate()
        try:
            gunicorn_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            gunicorn_proc.kill()
    if os.path.exists(PID_FILE):
        os.remove(PID_FILE)
    log("Stopped.")
    sys.exit(0)


def main() -> None:
    global gunicorn_proc

    # ── Preflight checks ─────────────────────────────────────
    if not os.path.isdir(VENV_DIR):
        log(f"Virtual environment not found at: {VENV_DIR}")
        log("Create one with:")
        log("  python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt")
        sys.exit(1)

    gunicorn_bin = os.path.join(VENV_DIR, "bin", "gunicorn")
    if not os.path.isfile(gunicorn_bin):
        log("gunicorn not found in venv. Install it with:")
        log("  source venv/bin/activate && pip install gunicorn")
        sys.exit(1)

    # ── Already running? ─────────────────────────────────────
    if port_in_use(PORT):
        log(f"Port {PORT} is already in use — opening browser to existing instance.")
        open_browser(BROWSER_URL)
        time.sleep(2)
        sys.exit(0)

    # ── Register signal handlers ─────────────────────────────
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # ── Start gunicorn ───────────────────────────────────────
    log(f"Starting MODAQ Upload (gunicorn on port {PORT})...")

    gunicorn_proc = subprocess.Popen(
        [
            gunicorn_bin,
            "--bind",
            f"127.0.0.1:{PORT}",
            "--workers",
            "4",
            "--timeout",
            "300",
            "--pid",
            PID_FILE,
            "--access-logfile",
            "-",
            "--error-logfile",
            "-",
            "app:create_app()",
        ],
        cwd=PROJECT_DIR,
    )

    # ── Wait for server ──────────────────────────────────────
    log("Waiting for server...")
    if not wait_for_server():
        log("Server did not start. Check output above.")
        sys.exit(1)

    # ── Open browser ─────────────────────────────────────────
    log("Server is ready!")
    log(f"MODAQ Upload is running at: {BROWSER_URL}")
    log("Press Ctrl+C to stop the server.")

    open_browser(BROWSER_URL)

    # ── Block until gunicorn exits ───────────────────────────
    try:
        gunicorn_proc.wait()
    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
