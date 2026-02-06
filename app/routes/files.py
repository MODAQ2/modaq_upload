"""File browsing API routes for modaq_upload"""

from pathlib import Path

from flask import Blueprint, Response, jsonify, request

from app.config import get_settings
from app.services import s3_service

files_bp = Blueprint("files", __name__)


@files_bp.route("/list", methods=["GET"])
def list_files() -> tuple[Response, int]:
    """List files and folders in S3 bucket.

    Query parameters:
        prefix: S3 prefix to filter by (default: "")
        delimiter: Delimiter for grouping (default: "/")

    Returns:
        JSON response with folders and files
    """
    settings = get_settings()

    if not settings.s3_bucket:
        return jsonify({"error": "S3 bucket not configured"}), 400

    prefix = request.args.get("prefix", "")
    delimiter = request.args.get("delimiter", "/")

    try:
        client = s3_service.create_s3_client(
            settings.aws_profile,
            settings.aws_region,
        )

        result = s3_service.list_bucket_objects(
            client,
            settings.s3_bucket,
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
    settings = get_settings()

    if not settings.s3_bucket:
        return jsonify({"error": "S3 bucket not configured"}), 400

    key = request.args.get("key", "")
    if not key:
        return jsonify({"error": "Object key required"}), 400

    try:
        client = s3_service.create_s3_client(
            settings.aws_profile,
            settings.aws_region,
        )

        result = s3_service.get_object_metadata(
            client,
            settings.s3_bucket,
            key,
        )

        if not result["success"]:
            return jsonify({"error": result["error"]}), 404

        return jsonify(result), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@files_bp.route("/search", methods=["GET"])
def search_files() -> tuple[Response, int]:
    """Search for files in S3 bucket by name pattern.

    Query parameters:
        query: Search query string
        prefix: S3 prefix to search within (default: "")

    Returns:
        JSON response with matching files
    """
    settings = get_settings()

    if not settings.s3_bucket:
        return jsonify({"error": "S3 bucket not configured"}), 400

    query = request.args.get("query", "").lower()
    prefix = request.args.get("prefix", "")

    if not query:
        return jsonify({"error": "Search query required"}), 400

    try:
        client = s3_service.create_s3_client(
            settings.aws_profile,
            settings.aws_region,
        )

        # List all objects with prefix (no delimiter to get all files)
        result = s3_service.list_bucket_objects(
            client,
            settings.s3_bucket,
            prefix=prefix,
            delimiter="",  # No delimiter to get all nested files
            max_keys=10000,
        )

        if not result["success"]:
            return jsonify({"error": result["error"]}), 500

        # Filter files by query
        matching_files = [f for f in result["files"] if query in f["name"].lower()]

        return jsonify(
            {
                "success": True,
                "query": query,
                "prefix": prefix,
                "files": matching_files[:100],  # Limit results
                "total_matches": len(matching_files),
            }
        ), 200

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
    # Get requested path, default to home directory
    requested_path = request.args.get("path", "")

    if not requested_path:
        # Default to home directory
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

    # Build response
    folders: list[dict[str, str | int]] = []
    files: list[dict[str, str | int]] = []
    mcap_count = 0

    try:
        for entry in sorted(path.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
            # Skip hidden files/folders (starting with .)
            if entry.name.startswith("."):
                continue

            try:
                if entry.is_dir():
                    # Count MCAP files in this folder (non-recursive, for preview)
                    try:
                        mcap_in_folder = sum(1 for f in entry.iterdir() if f.suffix == ".mcap")
                    except PermissionError:
                        mcap_in_folder = 0

                    folders.append(
                        {
                            "name": entry.name,
                            "path": str(entry),
                            "mcap_count": mcap_in_folder,
                        }
                    )
                elif entry.is_file():
                    if entry.suffix == ".mcap":
                        mcap_count += 1
                        files.append(
                            {
                                "name": entry.name,
                                "path": str(entry),
                                "size": entry.stat().st_size,
                            }
                        )
            except PermissionError:
                # Skip entries we can't access
                continue

    except PermissionError:
        return jsonify({"error": f"Permission denied: {path}"}), 403

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
            for vol in volumes_path.iterdir():
                if vol.is_dir() and not vol.name.startswith("."):
                    quick_links.append({"name": vol.name, "path": str(vol)})
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
        }
    ), 200
