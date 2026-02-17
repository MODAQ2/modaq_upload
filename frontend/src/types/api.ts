/** TypeScript types matching the Flask API response shapes. */

// ── Upload types ──

export type UploadStatus =
  | "pending"
  | "analyzing"
  | "ready"
  | "uploading"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export interface FileUploadState {
  filename: string;
  local_path: string;
  file_size: number;
  file_size_formatted: string;
  status: UploadStatus;
  s3_path: string;
  start_time: string | null;
  bytes_uploaded: number;
  progress_percent: number;
  error_message: string;
  is_duplicate: boolean;
  is_valid: boolean;
  upload_started_at: string | null;
  upload_completed_at: string | null;
  upload_duration_seconds: number | null;
  upload_speed_mbps: number | null;
}

export interface UploadJobProgress {
  job_id: string;
  status: UploadStatus;
  progress_percent: number;
  files_completed: number;
  total_files: number;
  uploaded_bytes_formatted: string;
  total_bytes_formatted: string;
  eta_seconds: number | null;
  files_failed: number;
  files_skipped: number;
  files_uploaded: number;
  cancelled: boolean;
  files: FileUploadState[];
}

export interface UploadJob {
  job_id: string;
  status: UploadStatus;
  files: FileUploadState[];
  total_files: number;
  files_completed: number;
  files_failed: number;
  files_skipped: number;
  files_uploaded: number;
  total_bytes: number;
  total_bytes_formatted: string;
  uploaded_bytes: number;
  uploaded_bytes_formatted: string;
  successfully_uploaded_bytes: number;
  successfully_uploaded_bytes_formatted: string;
  progress_percent: number;
  eta_seconds: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  total_upload_duration_seconds: number | null;
  total_upload_duration_formatted: string | null;
  average_upload_speed_mbps: number | null;
  cancelled: boolean;
  auto_upload: boolean;
  has_valid_uploadable_files: boolean;
  pre_filter_stats: PreFilterStats;
}

export interface PreFilterStats {
  total: number;
  cache_hits: number;
  cache_skipped: number;
  s3_hits: number;
  no_timestamp: number;
  to_analyze: number;
  file_statuses?: FilePreFilterStatus[];
}

export interface FilePreFilterStatus {
  path: string;
  filename: string;
  size: number;
  mtime: number;
  already_uploaded: boolean;
  s3_path?: string;
}

// ── SSE event types ──

export interface AnalysisProgressEvent {
  type: "analysis_progress";
  job_id: string;
  job_status: UploadStatus;
  file: FileUploadState;
  total_files: number;
  analysis_complete: boolean;
}

export interface AnalysisCompleteEvent {
  type: "analysis_complete";
  job: UploadJob;
  auto_upload?: boolean;
}

export interface AutoUploadStartingEvent {
  type: "auto_upload_starting";
  job_id: string;
}

// ── Scan types ──

export interface ScannedFileInfo {
  path: string;
  filename: string;
  size: number;
  mtime: number;
  relative_path: string;
  already_uploaded?: boolean;
}

export interface ScannedFolder {
  relative_path: string;
  files: ScannedFileInfo[];
  total_files: number;
  already_uploaded: number;
  all_uploaded: boolean;
  error: string | null;
}

export interface ScanStartedEvent {
  type: "scan_started";
  folders_total: number;
  root_folder: string;
}

export interface ScanFolderCompleteEvent {
  type: "scan_folder_complete";
  folder: ScannedFolder;
  folders_scanned: number;
  folders_total: number;
  running_totals: {
    total_files_found: number;
    total_already_uploaded: number;
    total_size: number;
  };
}

export interface ScanCompleteEvent {
  type: "scan_complete";
  status: string;
  folders_scanned: number;
  folders_total: number;
  total_files_found: number;
  total_already_uploaded: number;
  total_size: number;
  error?: string;
}

export type ScanEvent = ScanStartedEvent | ScanFolderCompleteEvent | ScanCompleteEvent;

// ── Bulk analyze response ──

export interface BulkAnalyzeResponse {
  job_id: string;
  status: string;
  total_files: number;
  pre_filter_stats: PreFilterStats;
  auto_upload: boolean;
}

// ── File browser types ──

export interface BrowseResponse {
  success: boolean;
  current_path: string;
  parent_path: string | null;
  breadcrumbs: BreadcrumbItem[];
  quick_links: QuickLink[];
  folders: LocalFolder[];
  files: LocalFile[];
  mcap_count: number;
  total_mcap_count: number;
  already_uploaded: number;
}

export interface BreadcrumbItem {
  name: string;
  path: string;
}

export interface QuickLink {
  name: string;
  path: string;
}

export interface LocalFolder {
  name: string;
  path: string;
  mcap_count: number;
  already_uploaded: number;
}

export interface LocalFile {
  name: string;
  path: string;
  size: number;
  mtime: number;
  already_uploaded?: boolean;
}

// ── S3 browser types ──

export interface S3ListResponse {
  success: boolean;
  folders: S3Folder[];
  files: S3File[];
  breadcrumbs: S3Breadcrumb[];
  prefix?: string;
  error?: string;
}

export interface S3Folder {
  name: string;
  prefix: string;
}

export interface S3File {
  name: string;
  key: string;
  size: number;
  last_modified: string;
}

export interface S3Breadcrumb {
  name: string;
  prefix: string;
}

// ── Settings types ──

export interface AppSettings {
  aws_profile: string;
  aws_region: string;
  s3_bucket: string;
  default_upload_folder: string;
  display_name: string;
  log_directory: string;
}

export interface VersionInfo {
  version: string;
  commit: string;
  branch: string;
  dirty: boolean;
}

export interface UpdateCheckResult {
  updates_available: boolean;
  current_commit: string;
  remote_commit: string;
  commits_behind: number;
}

export interface UpdateResult {
  success: boolean;
  results: {
    git_pull: { success: boolean; output: string };
    pip_install: { success: boolean; output: string };
    modaq_toolkit: { success: boolean; output: string };
  };
  message: string;
}

export interface ConnectionTestResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface CacheStats {
  success: boolean;
  stats: {
    total_entries: number;
    exists_count: number;
    not_exists_count: number;
    bucket: string;
  };
}

export interface CacheSyncResult {
  success: boolean;
  bucket?: string;
  files_in_s3?: number;
  files_updated?: number;
  files_removed?: number;
  message?: string;
  error?: string;
}

// ── Log types ──

export interface LogEntry {
  id: number;
  timestamp: string;
  level: string;
  category: string;
  event: string;
  message: string;
  metadata: Record<string, unknown>;
}

export interface LogEntriesResponse {
  entries: LogEntry[];
  total: number;
  offset: number;
  limit: number;
}

export interface LogStats {
  total_entries: number;
  today_entries: number;
  total_size_bytes: number;
  level_counts: Record<string, number>;
  category_counts: Record<string, number>;
  date_range: { earliest: string | null; latest: string | null };
  file_count: number;
  csv_count: number;
  csv_files: CsvFileInfo[];
}

export interface CsvFileInfo {
  path: string;
  filename: string;
  date: string;
  size: number;
}

export interface CsvPreviewResponse {
  columns: string[];
  rows: Record<string, string>[];
}

// ── Upload stats types ──

export interface UploadSessionFile {
  filename: string;
  file_size_formatted: string;
  status: string;
  upload_speed_mbps: string;
  s3_path: string;
  error_message: string;
}

export interface UploadSession {
  csv_path: string;
  date: string;
  time: string;
  total_files: number;
  completed: number;
  failed: number;
  skipped: number;
  total_bytes: number;
  total_bytes_formatted: string;
  total_duration_seconds: number;
  avg_speed_mbps: number;
  files: UploadSessionFile[];
}

export interface UploadStatsResponse {
  total_files_uploaded: number;
  total_files_failed: number;
  total_files_skipped: number;
  total_bytes_uploaded: number;
  total_bytes_uploaded_formatted: string;
  total_sessions: number;
  sessions: UploadSession[];
}
