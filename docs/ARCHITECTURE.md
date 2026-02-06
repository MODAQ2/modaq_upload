# Architecture

## Project Structure

```
modaq_upload/
├── app/
│   ├── __init__.py              # Flask app factory
│   ├── config.py                # Settings management
│   ├── routes/
│   │   ├── main.py              # Page routes
│   │   ├── upload.py            # Upload API
│   │   ├── files.py             # S3 file listing API
│   │   └── settings.py          # Settings API
│   ├── services/
│   │   ├── s3_service.py        # S3 operations
│   │   ├── mcap_service.py      # MCAP parsing
│   │   ├── cache_service.py     # SQLite cache for S3 lookups
│   │   └── upload_manager.py    # Upload orchestration
│   ├── static/js/
│   │   ├── app.js               # Entry point: page detection, dynamic imports
│   │   └── modules/
│   │       ├── state.js         # Centralized mutable state
│   │       ├── utils.js         # Formatting helpers, notifications
│   │       ├── stepper.js       # Upload step indicator
│   │       ├── about.js         # About modal
│   │       ├── file-handler.js  # File extraction from drag-and-drop
│   │       ├── upload-control.js # Cancel/reset operations
│   │       ├── upload-exec.js   # Upload start, SSE progress
│   │       ├── analysis.js      # File analysis/validation
│   │       ├── folder-browser.js # Folder browser modal
│   │       ├── upload-init.js   # Upload page init + event wiring
│   │       ├── file-browser.js  # S3 browser page
│   │       └── settings.js      # Settings page
│   └── templates/
│       ├── base.html            # Base template with Tailwind
│       ├── index.html           # Upload page
│       ├── files.html           # File browser page
│       └── settings.html        # Settings page
├── deploy/
│   ├── install.py               # Production installation script
│   ├── uninstall.py             # Uninstallation script
│   └── modaq-upload.service     # systemd service file
├── tests/
│   ├── test_mcap_service.py     # MCAP parsing tests
│   ├── test_s3_service.py       # S3 operations tests (moto)
│   ├── test_upload_manager.py   # Upload job management tests
│   ├── test_routes.py           # Flask API endpoint tests
│   └── js/                      # JavaScript tests (Vitest + jsdom)
├── archive/                     # Original scripts for reference
├── .env                         # Environment config (gitignored)
├── .env.example                 # Environment config template
├── settings.json                # User settings (gitignored)
├── settings.default.json        # Default settings template
├── modaq_upload_cache.db        # SQLite cache (gitignored)
├── requirements.txt             # Production dependencies
├── requirements-dev.txt         # Development dependencies
├── pyproject.toml               # Project config (ruff, mypy)
├── package.json                 # JS dev tooling (biome, tsc, vitest)
├── biome.json                   # Biome linter/formatter config
├── jsconfig.json                # TypeScript checkJs config
├── vitest.config.js             # Vitest test runner config
└── app.py                       # Entry point
```

## API Endpoints

| Endpoint                          | Method  | Description                |
| --------------------------------- | ------- | -------------------------- |
| `/`                               | GET     | Upload page                |
| `/files`                          | GET     | S3 browser page            |
| `/settings`                       | GET     | Settings page              |
| `/api/upload/analyze`             | POST    | Analyze files for upload   |
| `/api/upload/bulk-analyze`        | POST    | Bulk analyze files         |
| `/api/upload/scan-folder`         | POST    | Scan folder for files      |
| `/api/upload/start/<job_id>`      | POST    | Start uploading files      |
| `/api/upload/progress/<job_id>`   | GET     | SSE progress stream        |
| `/api/upload/status/<job_id>`     | GET     | Get job status             |
| `/api/upload/active`              | GET     | Get active upload job      |
| `/api/upload/cancel/<job_id>`     | POST    | Cancel upload              |
| `/api/files/list`                 | GET     | List S3 objects            |
| `/api/files/browse`               | GET     | Browse S3 files            |
| `/api/files/search`               | GET     | Search S3 objects          |
| `/api/files/info`                 | GET     | Get object metadata        |
| `/api/settings`                   | GET/PUT | Read/update settings       |
| `/api/settings/profiles`          | GET     | List AWS profiles          |
| `/api/settings/validate`          | POST    | Test S3 connection         |
| `/api/settings/version`           | GET     | Get version info           |
| `/api/settings/check-updates`     | GET     | Check for updates          |
| `/api/settings/update`            | POST    | Run update                 |
| `/api/settings/cache/stats`       | GET     | Cache statistics           |
| `/api/settings/cache/invalidate`  | POST    | Invalidate cache           |
| `/api/settings/cache/sync`        | POST    | Sync cache with S3         |