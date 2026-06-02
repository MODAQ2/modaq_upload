"""Tests for Flask route endpoints."""

import json
from unittest.mock import MagicMock, patch

from flask import Flask
from flask.testing import FlaskClient


class TestMainRoutes:
    """Tests for main page routes."""

    def test_index_page(self, client: FlaskClient) -> None:
        """Test that index page serves the React SPA shell."""
        response = client.get("/")
        assert response.status_code == 200
        assert b'<div id="root">' in response.data

    def test_files_page(self, client: FlaskClient) -> None:
        """Test that files page serves the React SPA shell."""
        response = client.get("/files")
        assert response.status_code == 200
        assert b'<div id="root">' in response.data

    def test_settings_page(self, client: FlaskClient) -> None:
        """Test that settings page serves the React SPA shell."""
        response = client.get("/settings")
        assert response.status_code == 200
        assert b'<div id="root">' in response.data


class TestSettingsAPI:
    """Tests for settings API endpoints."""

    def test_get_settings(self, client: FlaskClient) -> None:
        """Test getting current settings."""
        response = client.get("/api/settings")
        assert response.status_code == 200

        data = json.loads(response.data)
        assert "aws_profile" in data
        assert "aws_region" in data
        assert "s3_bucket" in data

    def test_update_settings(self, client: FlaskClient) -> None:
        """Test updating settings."""
        response = client.put(
            "/api/settings",
            data=json.dumps({"s3_bucket": "new-bucket"}),
            content_type="application/json",
        )
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data["s3_bucket"] == "new-bucket"

    def test_update_settings_invalid_key(self, client: FlaskClient) -> None:
        """Test that invalid settings keys are ignored."""
        response = client.put(
            "/api/settings",
            data=json.dumps({"invalid_key": "value"}),
            content_type="application/json",
        )
        assert response.status_code == 400

    def test_update_settings_no_json(self, client: FlaskClient) -> None:
        """Test error when no JSON body provided."""
        response = client.put("/api/settings", data="not json")
        assert response.status_code == 400

    def test_get_profiles(self, client: FlaskClient) -> None:
        """Test getting available AWS profiles."""
        response = client.get("/api/settings/profiles")
        assert response.status_code == 200

        data = json.loads(response.data)
        assert "profiles" in data
        assert isinstance(data["profiles"], list)
        assert "default" in data["profiles"]

    @patch("app.routes.settings.s3_service")
    def test_validate_connection_success(self, mock_s3: MagicMock, client: FlaskClient) -> None:
        """Test successful connection validation."""
        mock_s3.create_s3_client.return_value = MagicMock()
        mock_s3.validate_bucket_access.return_value = {"success": True, "error": None}

        response = client.post(
            "/api/settings/validate",
            data=json.dumps({"s3_bucket": "test-bucket"}),
            content_type="application/json",
        )
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data["success"] is True

    def test_validate_connection_no_bucket(self, client: FlaskClient) -> None:
        """Test validation fails without bucket."""
        # First clear the bucket
        client.put(
            "/api/settings",
            data=json.dumps({"s3_bucket": ""}),
            content_type="application/json",
        )

        response = client.post("/api/settings/validate")
        assert response.status_code == 400

    def test_get_version(self, client: FlaskClient) -> None:
        """Test getting version info."""
        response = client.get("/api/settings/version")
        assert response.status_code == 200

        data = json.loads(response.data)
        # Version info may or may not be available depending on git
        assert "commit" in data or "error" in data


class TestUploadAPI:
    """Tests for upload API endpoints."""

    def test_analyze_no_files(self, client: FlaskClient) -> None:
        """Test analyze endpoint with no files."""
        response = client.post("/api/upload/analyze")
        assert response.status_code == 400

        data = json.loads(response.data)
        assert "error" in data

    def test_analyze_with_json_paths(self, client: FlaskClient) -> None:
        """Test analyze endpoint with JSON file paths."""
        # Nonexistent files will result in empty job, returns 202 (async processing)
        response = client.post(
            "/api/upload/analyze",
            data=json.dumps({"file_paths": ["/nonexistent/file.mcap"]}),
            content_type="application/json",
        )
        assert response.status_code == 202

        data = json.loads(response.data)
        assert "job_id" in data
        assert data["status"] == "analyzing"

    def test_get_status_not_found(self, client: FlaskClient) -> None:
        """Test getting status for nonexistent job."""
        response = client.get("/api/upload/status/nonexistent-job-id")
        assert response.status_code == 404

    def test_cancel_upload_not_found(self, client: FlaskClient) -> None:
        """Test cancelling nonexistent upload."""
        response = client.post("/api/upload/cancel/nonexistent-job-id")
        assert response.status_code == 404

    def test_start_upload_not_found(self, client: FlaskClient) -> None:
        """Test starting nonexistent upload."""
        response = client.post("/api/upload/start/nonexistent-job-id")
        assert response.status_code == 404


class TestFilesAPI:
    """Tests for files API endpoints."""

    @patch("app.routes.files.s3_service")
    def test_list_files_success(self, mock_s3: MagicMock, client: FlaskClient) -> None:
        """Test listing files successfully."""
        # Ensure bucket is set
        client.put(
            "/api/settings",
            data=json.dumps({"s3_bucket": "test-bucket"}),
            content_type="application/json",
        )

        mock_s3.create_s3_client.return_value = MagicMock()
        mock_s3.list_bucket_objects.return_value = {
            "success": True,
            "bucket": "test-bucket",
            "prefix": "",
            "folders": [{"name": "folder1", "prefix": "folder1/"}],
            "files": [{"name": "file.mcap", "key": "file.mcap", "size": 1000}],
            "error": None,
        }

        response = client.get("/api/files/list")
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data["success"] is True
        assert "folders" in data
        assert "files" in data

    def test_list_files_no_bucket(self, client: FlaskClient) -> None:
        """Test listing files without bucket configured."""
        # Clear the bucket first
        client.put(
            "/api/settings",
            data=json.dumps({"s3_bucket": ""}),
            content_type="application/json",
        )

        response = client.get("/api/files/list")
        assert response.status_code == 400

    def test_get_file_info_no_key(self, client: FlaskClient) -> None:
        """Test getting file info without key parameter."""
        response = client.get("/api/files/info")
        assert response.status_code == 400


class TestLogsAPI:
    """Tests for logs API endpoints."""

    def test_logs_page(self, client: FlaskClient) -> None:
        """Test that logs page serves the React SPA shell."""
        response = client.get("/logs")
        assert response.status_code == 200
        assert b'<div id="root">' in response.data

    def test_get_entries(self, client: FlaskClient) -> None:
        """Test getting log entries."""
        response = client.get("/api/logs/entries")
        assert response.status_code == 200

        data = json.loads(response.data)
        assert "entries" in data
        assert "total" in data
        assert isinstance(data["entries"], list)

    def test_get_entries_with_filters(self, client: FlaskClient) -> None:
        """Test getting log entries with query params."""
        response = client.get("/api/logs/entries?level=INFO&category=app&limit=10")
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data["limit"] == 10

    def test_get_files(self, client: FlaskClient) -> None:
        """Test listing log files."""
        response = client.get("/api/logs/files")
        assert response.status_code == 200

        data = json.loads(response.data)
        assert "files" in data
        assert isinstance(data["files"], list)

    def test_get_stats(self, client: FlaskClient) -> None:
        """Test getting log stats."""
        response = client.get("/api/logs/stats")
        assert response.status_code == 200

        data = json.loads(response.data)
        assert "total_entries" in data
        assert "level_counts" in data

    def test_sync_no_bucket(self, client: FlaskClient) -> None:
        """Test sync fails without bucket configured."""
        # Clear bucket
        client.put(
            "/api/settings",
            data=json.dumps({"s3_bucket": ""}),
            content_type="application/json",
        )

        response = client.post("/api/logs/sync")
        assert response.status_code == 400

    @patch("app.routes.logs.s3_service")
    def test_sync_success(self, mock_s3: MagicMock, client: FlaskClient) -> None:
        """Test successful log sync."""
        # Ensure bucket is set
        client.put(
            "/api/settings",
            data=json.dumps({"s3_bucket": "test-bucket"}),
            content_type="application/json",
        )

        mock_s3.create_s3_client.return_value = MagicMock()

        response = client.post("/api/logs/sync")
        assert response.status_code == 200

        data = json.loads(response.data)
        assert "synced" in data


class TestAutomaticLogging:
    """Tests for the automatic request-logging hook and global error handler."""

    def test_api_request_is_logged(self, client: FlaskClient) -> None:
        """Every /api/* request is recorded as a 'request' log entry."""
        from app.services.log_service import get_log_service

        client.get("/api/settings/version")

        entries = get_log_service().read_log_entries(category="request", limit=50)["entries"]
        assert any(
            e["event"] == "http_request" and "/api/settings/version" in e["message"]
            for e in entries
        )

    def test_log_endpoints_are_not_logged(self, client: FlaskClient) -> None:
        """Requests to /api/logs/* are skipped to avoid feedback loops."""
        from app.services.log_service import get_log_service

        client.get("/api/logs/stats")

        entries = get_log_service().read_log_entries(category="request", limit=100)["entries"]
        assert not any("/api/logs/stats" in e["message"] for e in entries)

    def test_uncaught_exception_is_logged_and_returns_500(
        self, app: Flask, client: FlaskClient
    ) -> None:
        """An uncaught exception is logged at ERROR level and returns a 500 JSON body."""
        from app.services.log_service import get_log_service

        @app.route("/api/_test_boom")
        def _boom() -> str:
            raise ValueError("kaboom for testing")

        response = client.get("/api/_test_boom")
        assert response.status_code == 500
        assert json.loads(response.data)["error"] == "Internal server error"

        entries = get_log_service().read_log_entries(level="ERROR", limit=50)["entries"]
        crash = next((e for e in entries if e["event"] == "unhandled_exception"), None)
        assert crash is not None
        assert crash["metadata"]["exception_type"] == "ValueError"
        assert "traceback" in crash["metadata"]

    def test_404_is_not_logged_as_crash(self, client: FlaskClient) -> None:
        """HTTP errors keep default handling and are not logged as unhandled crashes."""
        from app.services.log_service import get_log_service

        response = client.get("/api/upload/does-not-exist")
        assert response.status_code == 404

        entries = get_log_service().read_log_entries(level="ERROR", limit=50)["entries"]
        assert not any(e["event"] == "unhandled_exception" for e in entries)

    def test_client_log_endpoint_records_browser_error(self, client: FlaskClient) -> None:
        """POST /api/logs/client stores a browser-side error in the 'client' category."""
        from app.services.log_service import get_log_service

        response = client.post(
            "/api/logs/client",
            data=json.dumps(
                {
                    "level": "ERROR",
                    "event": "uncaught_error",
                    "message": "TypeError: x is undefined",
                    "metadata": {"url": "http://localhost/files", "stack": "at foo()"},
                }
            ),
            content_type="application/json",
        )
        assert response.status_code == 200
        assert json.loads(response.data)["success"] is True

        entries = get_log_service().read_log_entries(category="client", limit=50)["entries"]
        entry = next((e for e in entries if e["event"] == "uncaught_error"), None)
        assert entry is not None
        assert entry["message"] == "TypeError: x is undefined"
        assert entry["metadata"]["url"] == "http://localhost/files"
        assert "user_agent" in entry["metadata"]


class TestProgressSSE:
    """Tests for Server-Sent Events progress endpoint."""

    def test_progress_stream_not_found(self, client: FlaskClient) -> None:
        """Test progress stream for nonexistent job returns error."""
        response = client.get("/api/upload/progress/nonexistent-job-id")

        # SSE streams return 200 even for errors (error is in the stream)
        assert response.status_code == 200
        assert "text/event-stream" in response.content_type
