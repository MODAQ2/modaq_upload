"""File browsing API routes for modaq_upload"""

import os
from pathlib import Path

from flask import Blueprint, Response, g, jsonify, request

from app.config import get_settings
from app.services import s3_service
from app.services.cache_service import get_cache_service

files_bp = Blueprint("files", __name__)


@files_bp.before_request
def _require_bucket() -> tuple[Response, int] | None:
    """Ensure S3 bucket is configured before handling any request."""
    settings = get_settings()
    if not settings.s3_bucket:
        return jsonify({"error": "S3 bucket not configured"}), 400
    g.settings = settings
    return None


@files_bp.route("/list", methods=["GET"])
def list_files() -> tuple[Response, int]:
    """List files and folders in S3 bucket.

    Query parameters:
        prefix: S3 prefix to filter by (default: "")
        delimiter: Delimiter for grouping (default: "/")

    Returns:
        JSON response with folders and files
    """
    prefix = request.args.get("prefix", "")
    delimiter = request.args.get("delimiter", "/")

    try:
        client = s3_service.create_s3_client(
            g.settings.aws_profile,
            g.settings.aws_region,
        )

        result = s3_service.list_bucket_objects(
            client,
            g.settings.s3_bucket,
            prefix=prefix,
            delimiter=delimiter,
        )

        if not result["success"]:
            return jsonify({"error": result["error"]}), 500

        # Add breadcrumb navigation
        breadcrumbs = []
        if prefix:
            parts = prefix.rstrip("/").split("/")
            current_path = ""
            for part in parts:
                current_path += part + "/"
                breadcrumbs.append({"name": part, "prefix": current_path})

        result["breadcrumbs"] = breadcrumbs
        return jsonify(result), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@files_bp.route("/info", methods=["GET"])
def get_file_info() -> tuple[Response, int]:
    """Get metadata for a specific S3 object.

    Query parameters:
        key: S3 object key

    Returns:
        JSON response with object metadata
    """
    key = request.args.get("key", "")
    if not key:
        return jsonify({"error": "Object key required"}), 400

    try:
        client = s3_service.create_s3_client(
            g.settings.aws_profile,
            g.settings.aws_region,
        )

        result = s3_service.get_object_metadata(
            client,
            g.settings.s3_bucket,
            key,
        )

        if not result["success"]:
            return jsonify({"error": result["error"]}), 404

        return jsonify(result), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@files_bp.route("/browse", methods=["GET"])
def browse_local() -> tuple[Response, int]:
    """Browse local filesystem for folder selection.

    Query parameters:
        path: Directory path to browse (default: user's home directory)

    Returns:
        JSON response with folders, files, and navigation info
    """
    # Get requested path, default to configured upload folder or home directory
    requested_path = request.args.get("path", "")

    if not requested_path:
        settings = get_settings()
        default_folder = settings.default_upload_folder
        if default_folder and Path(default_folder).is_dir():
            requested_path = default_folder
        else:
            requested_path = str(Path.home())

    path = Path(requested_path)

    # Handle special paths
    if requested_path == "/":
        # On macOS/Linux, show root. On Windows, this would need special handling.
        path = Path("/")

    # Security: resolve to absolute path and check it exists
    try:
        path = path.resolve()
    except (OSError, RuntimeError) as e:
        return jsonify({"error": f"Invalid path: {e}"}), 400

    if not path.exists():
        return jsonify({"error": f"Path not found: {path}"}), 404

    if not path.is_dir():
        return jsonify({"error": f"Not a directory: {path}"}), 400

    # Build response — single-pass walk for recursive MCAP counts + cache checks.
    # os.walk with onerror skips unreadable subdirectories instead of aborting,
    # which is important on Linux where permission errors are common.
    cache = get_cache_service()
    bucket = g.settings.s3_bucket

    folder_mcap_counts: dict[str, int] = {}
    folder_uploaded_counts: dict[str, int] = {}
    files: list[dict[str, str | int | float | bool]] = []
    mcap_count = 0
    direct_uploaded = 0

    def _walk_error(err: OSError) -> None:
        pass  # Skip unreadable directories silently

    for dirpath, dirnames, filenames in os.walk(str(path), onerror=_walk_error):
        # Skip hidden directories in-place so os.walk won't descend into them
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]

        for fname in filenames:
            if not fname.endswith(".mcap") or fname.startswith("."):
                continue

            mcap_path = Path(dirpath) / fname
            rel = mcap_path.relative_to(path)
            parts = rel.parts

            try:
                file_stat = mcap_path.stat()
            except OSError:
                continue

            uploaded = cache.check_exists_by_filename(
                bucket, mcap_path.name, file_stat.st_size
            ) is True

            if len(parts) == 1:
                # Direct child MCAP file
                mcap_count += 1
                if uploaded:
                    direct_uploaded += 1
                files.append(
                    {
                        "name": mcap_path.name,
                        "path": str(mcap_path),
                        "size": file_stat.st_size,
                        "mtime": file_stat.st_mtime,
                        "already_uploaded": uploaded,
                    }
                )
            else:
                # Nested — attribute to the immediate subfolder
                folder_name = parts[0]
                folder_mcap_counts[folder_name] = folder_mcap_counts.get(folder_name, 0) + 1
                if uploaded:
                    folder_uploaded_counts[folder_name] = (
                        folder_uploaded_counts.get(folder_name, 0) + 1
                    )

    # Build folder list from direct children (non-hidden directories)
    folders: list[dict[str, str | int]] = []
    try:
        for entry in sorted(path.iterdir(), key=lambda x: x.name.lower()):
            if entry.name.startswith("."):
                continue
            try:
                if entry.is_dir():
                    folders.append(
                        {
                            "name": entry.name,
                            "path": str(entry),
                            "mcap_count": folder_mcap_counts.get(entry.name, 0),
                            "already_uploaded": folder_uploaded_counts.get(entry.name, 0),
                        }
                    )
            except PermissionError:
                continue
    except PermissionError:
        return jsonify({"error": f"Permission denied: {path}"}), 403

    # Sort files by name
    files.sort(key=lambda f: str(f["name"]).lower())

    # Build breadcrumbs for navigation
    breadcrumbs: list[dict[str, str]] = []
    current = path
    while current != current.parent:  # Stop at root
        breadcrumbs.insert(0, {"name": current.name or "/", "path": str(current)})
        current = current.parent
    # Add root
    if not breadcrumbs or breadcrumbs[0]["path"] != "/":
        breadcrumbs.insert(0, {"name": "/", "path": "/"})

    # Get common starting locations for quick navigation
    quick_links: list[dict[str, str]] = [
        {"name": "Home", "path": str(Path.home())},
    ]

    # Add Volumes on macOS
    volumes_path = Path("/Volumes")
    if volumes_path.exists():
        try:
            for vol in sorted(volumes_path.iterdir(), key=lambda x: x.name.lower()):
                if vol.is_dir() and not vol.name.startswith("."):
                    quick_links.append({"name": vol.name, "path": str(vol)})
        except PermissionError:
            pass

    # Add /media/m2 as a priority quick link on Linux if it exists
    media_m2 = Path("/media/m2")
    if media_m2.exists() and media_m2.is_dir():
        quick_links.append({"name": "m2", "path": str(media_m2)})

    # Add /media itself and its subdirectories on Linux (removable drives, USB, etc.)
    media_path = Path("/media")
    if media_path.exists() and not volumes_path.exists():
        quick_links.append({"name": "media", "path": str(media_path)})
        try:
            for entry in sorted(media_path.iterdir(), key=lambda x: x.name.lower()):
                if not entry.is_dir() or entry.name.startswith("."):
                    continue
                entry_str = str(entry)
                # Already added /media/m2 above
                if entry_str == str(media_m2):
                    continue
                # If it's a user directory (e.g. /media/username), list its children
                try:
                    children = [
                        c
                        for c in entry.iterdir()
                        if c.is_dir() and not c.name.startswith(".")
                    ]
                except PermissionError:
                    children = []
                if children:
                    for child in sorted(children, key=lambda x: x.name.lower()):
                        quick_links.append({"name": child.name, "path": str(child)})
                else:
                    quick_links.append({"name": entry.name, "path": entry_str})
        except PermissionError:
            pass

    return jsonify(
        {
            "success": True,
            "current_path": str(path),
            "parent_path": str(path.parent) if path.parent != path else None,
            "breadcrumbs": breadcrumbs,
            "quick_links": quick_links,
            "folders": folders,
            "files": files,  # Only MCAP files
            "mcap_count": mcap_count,
            "total_mcap_count": mcap_count + sum(folder_mcap_counts.values()),
            "already_uploaded": direct_uploaded + sum(folder_uploaded_counts.values()),
        }
    ), 200
