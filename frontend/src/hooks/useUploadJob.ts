/**
 * Hook that wraps bulk-analyze + auto-upload SSE progress.
 *
 * The SSE stream has two phases (analysis then upload) but this hook
 * exposes a single, simple interface. During upload only "active" files
 * (status=uploading|analyzing) are tracked — the full file list arrives
 * only in the terminal event and is stored in uploadStore.completedJob.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiPost } from "../api/client.ts";
import { useUploadStore } from "../stores/uploadStore.ts";
import type {
  AnalysisCompleteEvent,
  AnalysisProgressEvent,
  AutoUploadStartingEvent,
  FileUploadState,
  UploadJob,
  UploadJobProgress,
} from "../types/api.ts";
import { useSSE } from "./useSSE.ts";

interface StatusCounts {
  uploaded: number;
  skipped: number;
  failed: number;
}

interface UseUploadJobOptions {
  /** Called for each file update during analysis/upload. */
  onFileUpdate?: (file: FileUploadState) => void;
  /** Called with the full file list on completion. */
  onCompletion?: (files: FileUploadState[]) => void;
}

interface UseUploadJobResult {
  startUpload: (
    filePaths: string[],
    skipDuplicates?: boolean,
  ) => Promise<void>;
  cancelUpload: () => Promise<void>;
  filesProcessed: number;
  totalFiles: number;
  activeFiles: FileUploadState[];
  statusCounts: StatusCounts;
  progressPercent: number;
  eta: number | null;
  isRunning: boolean;
  isCancelling: boolean;
  uploadedBytesFormatted: string;
  totalBytesFormatted: string;
}

type SSEEvent =
  | AnalysisProgressEvent
  | AnalysisCompleteEvent
  | AutoUploadStartingEvent
  | UploadJobProgress
  | UploadJob;

/** Type guard: does this look like a progress dict (lightweight, during upload)? */
function isProgressDict(data: Record<string, unknown>): data is UploadJobProgress & Record<string, unknown> {
  return "job_id" in data && "total_files" in data && !("total_bytes" in data) && !("type" in data);
}

/** Type guard: does this look like a full UploadJob dict (terminal)? */
function isFullJobDict(data: Record<string, unknown>): data is UploadJob & Record<string, unknown> {
  return "job_id" in data && "total_bytes" in data && !("type" in data);
}

export function useUploadJob(options: UseUploadJobOptions = {}): UseUploadJobResult {
  const [jobId, setJobId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [filesProcessed, setFilesProcessed] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [activeFiles, setActiveFiles] = useState<FileUploadState[]>([]);
  const [statusCounts, setStatusCounts] = useState<StatusCounts>({
    uploaded: 0,
    skipped: 0,
    failed: 0,
  });
  const [progressPercent, setProgressPercent] = useState(0);
  const [eta, setEta] = useState<number | null>(null);
  const [uploadedBytesFormatted, setUploadedBytesFormatted] = useState("");
  const [totalBytesFormatted, setTotalBytesFormatted] = useState("");
  const [isCancelling, setIsCancelling] = useState(false);

  const { setUploadJobId, setCompletedJob } = useUploadStore();

  // Callback refs — kept in sync with latest options via effect
  const onFileUpdateRef = useRef(options.onFileUpdate);
  const onCompletionRef = useRef(options.onCompletion);

  useEffect(() => {
    onFileUpdateRef.current = options.onFileUpdate;
    onCompletionRef.current = options.onCompletion;
  });

  /** Handle each SSE event. */
  const handleMessage = useCallback(
    (raw: unknown) => {
      const data = raw as SSEEvent & Record<string, unknown>;
      if (!data || typeof data !== "object") return;

      // Typed events (analysis phase)
      if ("type" in data) {
        switch (data.type) {
          case "analysis_progress": {
            const evt = data as AnalysisProgressEvent;
            setTotalFiles(evt.total_files);
            // Show the file being analyzed as an active file.
            setActiveFiles((prev) => {
              const filtered = prev.filter(
                (f) => f.local_path !== evt.file.local_path,
              );
              if (
                evt.file.status === "analyzing" ||
                evt.file.status === "uploading"
              ) {
                return [...filtered, evt.file];
              }
              return filtered;
            });
            // Notify unified table
            onFileUpdateRef.current?.(evt.file);
            break;
          }

          case "analysis_complete": {
            const evt = data as AnalysisCompleteEvent;
            setTotalFiles(evt.job.total_files);
            // If not auto-uploading, this is terminal.
            if (!evt.auto_upload) {
              setIsRunning(false);
              setJobId(null);
              setCompletedJob(evt.job);
            }
            // Clear active files from analysis phase.
            setActiveFiles([]);
            break;
          }

          case "auto_upload_starting":
            // Upload phase beginning — keep running, active files will
            // arrive via progress dicts.
            break;

          default:
            break;
        }
        return;
      }

      // Lightweight progress dict (during upload)
      if (isProgressDict(data)) {
        const p = data as UploadJobProgress;
        setFilesProcessed(p.files_completed);
        setTotalFiles(p.total_files);
        setStatusCounts({
          uploaded: p.files_uploaded,
          skipped: p.files_skipped,
          failed: p.files_failed,
        });
        setProgressPercent(p.progress_percent);
        setEta(p.eta_seconds);
        setActiveFiles(p.files);
        setUploadedBytesFormatted(p.uploaded_bytes_formatted);
        setTotalBytesFormatted(p.total_bytes_formatted);

        // Notify unified table for each active file
        if (onFileUpdateRef.current) {
          for (const file of p.files) {
            onFileUpdateRef.current(file);
          }
        }

        // Terminal statuses in progress dict
        if (
          p.status === "completed" ||
          p.status === "failed" ||
          p.status === "cancelled"
        ) {
          setIsRunning(false);
          setIsCancelling(false);
          setJobId(null);
        }
        return;
      }

      // Full job dict (terminal event)
      if (isFullJobDict(data)) {
        const job = data as UploadJob;
        setFilesProcessed(job.files_completed);
        setTotalFiles(job.total_files);
        setStatusCounts({
          uploaded: job.files_uploaded,
          skipped: job.files_skipped,
          failed: job.files_failed,
        });
        setProgressPercent(job.progress_percent);
        setEta(null);
        setActiveFiles([]);
        setUploadedBytesFormatted(job.uploaded_bytes_formatted);
        setTotalBytesFormatted(job.total_bytes_formatted);
        setCompletedJob(job);
        // Notify unified table with all completion data
        onCompletionRef.current?.(job.files);
        setIsRunning(false);
        setIsCancelling(false);
        setJobId(null);
        return;
      }
    },
    [setCompletedJob],
  );

  const sseUrl = useMemo(
    () => (jobId && isRunning ? `/api/upload/progress/${jobId}` : null),
    [jobId, isRunning],
  );

  useSSE({
    url: sseUrl,
    onMessage: handleMessage,
    onError: () => {
      // Stream closed — if we're still "running" the server ended it.
      if (isRunning) {
        setIsRunning(false);
        setIsCancelling(false);
        setJobId(null);
      }
    },
  });

  /** Kick off a bulk-analyze + auto-upload job. */
  const startUpload = useCallback(
    async (filePaths: string[], skipDuplicates = true) => {
      // Reset state
      setFilesProcessed(0);
      setTotalFiles(0);
      setActiveFiles([]);
      setStatusCounts({ uploaded: 0, skipped: 0, failed: 0 });
      setProgressPercent(0);
      setEta(null);
      setUploadedBytesFormatted("");
      setTotalBytesFormatted("");
      setIsCancelling(false);
      setIsRunning(true);

      try {
        const res = await apiPost<{ job_id: string; total_files: number }>(
          "/api/upload/bulk-analyze",
          {
            file_paths: filePaths,
            auto_upload: true,
            skip_duplicates: skipDuplicates,
          },
        );
        setUploadJobId(res.job_id);
        setTotalFiles(res.total_files);
        setJobId(res.job_id);
      } catch {
        setIsRunning(false);
      }
    },
    [setUploadJobId],
  );

  /** Cancel the current upload job. SSE terminal event handles cleanup. */
  const cancelUpload = useCallback(async () => {
    const currentJobId = useUploadStore.getState().uploadJobId;
    if (!currentJobId) return;
    setIsCancelling(true);
    try {
      await apiPost(`/api/upload/cancel/${currentJobId}`);
    } catch {
      // If the cancel request itself fails, force-close
      setIsRunning(false);
      setJobId(null);
      setIsCancelling(false);
    }
  }, []);

  return {
    startUpload,
    cancelUpload,
    filesProcessed,
    totalFiles,
    activeFiles,
    statusCounts,
    progressPercent,
    eta,
    isRunning,
    isCancelling,
    uploadedBytesFormatted,
    totalBytesFormatted,
  };
}
