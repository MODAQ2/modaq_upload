/** TypeScript types for the Local Delete feature. */

// ── File status ──

export type DeleteFileStatus =
  | "pending"
  | "scanning"
  | "verifying"
  | "verified"
  | "deleting"
  | "deleted"
  | "mismatch"
  | "failed"
  | "cancelled";

// ── Scan response ──

export interface DeleteScanFile {
  filename: string;
  local_path: string;
  file_size: number;
  s3_path: string;
  s3_bucket: string;
  status: DeleteFileStatus;
  local_md5: string;
  s3_etag: string;
  s3_size: number;
  verification: string;
  error_message: string;
}

export interface DeleteScanResponse {
  success: boolean;
  job_id: string;
  folder_path: string;
  files: DeleteScanFile[];
  total_files: number;
  total_size: number;
}

// ── SSE event types ──

export interface DeleteProgressEvent {
  type: "delete_progress";
  job_id: string;
  status: string;
  total_files: number;
  files_processed: number;
  status_counts: Record<string, number>;
  total_deleted_size: number;
  cancelled: boolean;
}

export interface DeleteCompleteEvent {
  type: "delete_complete";
  job_id: string;
  status: string;
  total_files: number;
  files: DeleteScanFile[];
  status_counts: Record<string, number>;
  total_deleted_size: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled: boolean;
}

export type DeleteSSEEvent = DeleteProgressEvent | DeleteCompleteEvent;

// ── Job result (full response) ──

export interface DeleteJobResult {
  job_id: string;
  status: string;
  total_files: number;
  files: DeleteScanFile[];
  status_counts: Record<string, number>;
  total_deleted_size: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled: boolean;
}
