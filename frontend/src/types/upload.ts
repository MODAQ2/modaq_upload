/**
 * Types for the unified upload table that persists from Step 2 through Step 4.
 */

export type UnifiedStatus =
  | "new"
  | "already_uploaded"
  | "queued"
  | "in_progress"
  | "completed"
  | "skipped"
  | "failed";
export type UploadPhase = "review" | "uploading" | "summary";
export type SortKey = "filename" | "folder" | "size" | "mtime" | "status";
export type SortDir = "asc" | "desc";
export type StatusFilter =
  | "all"
  | "new"
  | "uploaded"
  | "queued"
  | "in_progress"
  | "completed"
  | "skipped"
  | "failed";

export interface UnifiedFileRow {
  /** Stable key — the local filesystem path. */
  path: string;
  filename: string;
  size: number;
  folder: string;
  mtime: number;
  /** Whether the file was already on S3 when scanned. */
  alreadyUploaded: boolean;
  /** Upload lifecycle status. */
  status: UnifiedStatus;
  /** 0–100 during upload. */
  progressPercent: number;
  /** Populated after successful upload. */
  s3Path: string;
  /** Upload duration in seconds. */
  duration: number | null;
  /** Upload speed in Mbps. */
  speed: number | null;
  /** Error message if failed. */
  error: string;
  /** Position in the frozen sort array (set during upload phase). */
  _frozenIndex?: number;
}
