# Changelog

## v1.2.0

- S3 file downloads: download files directly from the S3 browser.
- Large upload to existing folder: target an existing S3 prefix when running a large folder sync, not just newly created folders.
- Application log syncing: app logs and global frontend/backend errors are captured and uploaded to S3 for diagnostics.
- Per-user event logs: unique event logs are generated for each user.
- Faster S3 browsing: more efficient S3 listing strategy plus frontend improvements for the file browser.
- OS-standard log directories: logs now use platform-standard locations.

## v1.1.0

- Initial tracked release with in-app updater (git pull + pip install) from Settings.
