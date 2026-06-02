/** TypeScript types matching the Flask API response shapes. */

// ── Upload types ──

export type UploadStatus =
  | 'pending'
  | 'analyzing'
  | 'ready'
  | 'uploading'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface FileUploadState {
  filename: string;
  local_path: string;
  file_size: number;
  file_size_formatted: string;
  status: UploadStatus;
  s3_path: string;
  /** Configured file category name (e.g. "data", "logs"). Falls back to "other". */
  file_category: string;
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
  /**
   * Present only on the terminal event for jobs above large_job_threshold.
   * When true, `files` carries the cap-8 active list (not the full job);
   * full per-file results must be fetched from /api/upload/results.
   */
  terminal?: boolean;
}

/** Pagination payload returned by /api/upload/results/<job_id>. */
export interface JobResultsPage {
  job_id: string;
  files: FileUploadState[];
  pagination: {
    page: number;
    per_page: number;
    total_files: number;
    total_pages: number;
    has_next: boolean;
    has_prev: boolean;
  };
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
  type: 'analysis_progress';
  job_id: string;
  job_status: UploadStatus;
  file: FileUploadState;
  total_files: number;
  analysis_complete: boolean;
}

export interface AnalysisCompleteEvent {
  type: 'analysis_complete';
  job: UploadJob;
  auto_upload?: boolean;
}

export interface AutoUploadStartingEvent {
  type: 'auto_upload_starting';
  job_id: string;
}

// ── Batch processing types ──

export interface BatchProcessingSettings {
  enabled: boolean;
  batch_size: number;
  auto_tune_workers: boolean;
  max_workers: number;
  target_cpu_percent: number;
  skip_mcap_validation: boolean;
  use_database_for_large_jobs: boolean;
  large_job_threshold: number;
}

export interface BatchState {
  batch_id: number;
  total_batches: number;
  files_in_batch: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  files_processed: number;
  files_uploaded: number;
  files_failed: number;
  bytes_uploaded: number;
  started_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  error_message: string;
}

export interface BatchStartedEvent {
  type: 'batch_started';
  batch_id: number;
  total_batches: number;
  files_in_batch: number;
}

export interface BatchProgressEvent {
  type: 'batch_progress';
  batch_id: number;
  active_files: FileUploadState[]; // Max 8 items
  batch_files_completed: number;
  batch_files_total: number;
  job_files_completed: number;
  job_files_total: number;
  job_progress_percent: number;
}

export interface BatchCompletedEvent {
  type: 'batch_completed';
  batch_id: number;
  files_uploaded: number;
  files_failed: number;
}

export interface JobCompletedEvent {
  type: 'job_completed';
  job_id: string;
  status: 'completed' | 'failed' | 'cancelled';
  total_files: number;
  files_uploaded: number;
  files_failed: number;
  duration_seconds: number;
}

export interface PaginatedResults {
  job_id: string;
  files: FileUploadState[];
  pagination: {
    page: number;
    per_page: number;
    total_files: number;
    total_pages: number;
    has_next: boolean;
    has_prev: boolean;
  };
  job_metadata: {
    job_id: string;
    status: string;
    total_files: number;
    files_uploaded: number;
    files_failed: number;
    total_bytes: number;
  };
}

// ── Scan types ──

export interface ScannedFileInfo {
  path: string;
  filename: string;
  size: number;
  mtime: number;
  relative_path: string;
  already_uploaded?: boolean;
  /** Configured file category (e.g. "data", "logs"). Falls back to "other". */
  file_category?: string;
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
  type: 'scan_started';
  folders_total: number;
  root_folder: string;
}

export interface ScanFolderCompleteEvent {
  type: 'scan_folder_complete';
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
  type: 'scan_complete';
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
  /** Count of allowed files that are direct children of `current_path`. */
  file_count: number;
  /** Count of allowed files at this level plus all nested subfolders. */
  total_file_count: number;
  /** Per-category counts for direct children only (keyed by category name). */
  category_counts: Record<string, number>;
  /** Per-category counts including all nested subfolders (keyed by category name). */
  total_category_counts: Record<string, number>;
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
  file_count: number;
  already_uploaded: number;
  /** Per-category counts for files nested under this folder (keyed by category name). */
  category_counts: Record<string, number>;
}

export interface LocalFile {
  name: string;
  path: string;
  size: number;
  mtime: number;
  already_uploaded?: boolean;
  /** Configured category name (e.g. "data", "logs"). Falls back to "other". */
  file_category?: string;
}

// ── S3 browser types ──

export interface S3ListResponse {
  success: boolean;
  folders: S3Folder[];
  files: S3File[];
  breadcrumbs: S3Breadcrumb[];
  prefix?: string;
  /** Opaque continuation token; pass back as `token` to load the next page. Null when no more results. */
  next_token?: string | null;
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

export interface S3DownloadResponse {
  success: boolean;
  url: string;
  key: string;
  filename: string;
  error?: string;
}

export interface S3StatsResponse {
  success: boolean;
  prefix: string;
  folder_count: number;
  file_count: number;
  /** True when file_count hit the server's cap and the real total is higher. */
  capped?: boolean;
  error?: string;
}

// ── Settings types ──

export type ValueSourceType = 'builtin' | 'default_file' | 'settings_file' | 'env';

export interface ValueSource {
  source: ValueSourceType;
  /** Absolute path to the file (present for default_file and settings_file). */
  path?: string;
  /** Environment variable name (present for env). */
  env_var?: string;
}

export interface FileCategory {
  name: string;
  extensions: string[];
  partition_interval: '10min' | 'daily';
  description: string;
}

export interface AppSettings {
  aws_profile: string;
  aws_region: string;
  s3_bucket: string;
  default_upload_folder: string;
  display_name: string;
  log_directory: string;
  file_categories: FileCategory[];
  allowed_extensions: string[];
  batch_processing?: BatchProcessingSettings;
  /** Provenance metadata returned by the API — not sent on PUT. */
  value_sources?: Record<string, ValueSource>;
}

export interface VersionInfo {
  version: string;
  commit: string;
  branch: string;
  dirty: boolean;
}

export interface UpdateCheckResult {
  updates_available: boolean;
  up_to_date: boolean;
  current_commit: string | null;
  remote_commit: string | null;
  commits_behind: number;
  /** Version string from the remote pyproject.toml, e.g. "1.3.0". Null if not available. */
  remote_version: string | null;
  error: string | null;
}

export interface UpdateStepResult {
  success: boolean;
  output: string;
  /** Human-readable label, e.g. "Downloading update" */
  label: string;
}

export interface UpdateResult {
  success: boolean;
  failed_at: string | null;
  /** Full commit hash captured before the update, used for rollback. */
  pre_update_commit: string | null;
  /** Ordered list of step keys */
  step_order: string[];
  results: Record<string, UpdateStepResult>;
}

export interface RollbackResult {
  success: boolean;
  commit?: string;
  output?: string;
  error: string | null;
}

export interface BranchListResult {
  current: string | null;
  branches: string[];
  error: string | null;
}

export interface BranchSwitchResult {
  success: boolean;
  branch: string;
  output: string;
  error: string | null;
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
