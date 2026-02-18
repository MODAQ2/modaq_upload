/**
 * Hook for managing delete job execution and SSE progress.
 *
 * Mirrors the useUploadJob pattern: starts a delete job via POST,
 * then listens on SSE for per-file progress updates.
 */

import { useCallback, useMemo, useState } from "react";

import { apiPost } from "../api/client.ts";
import { useDeleteStore } from "../stores/deleteStore.ts";
import type {
  DeleteCompleteEvent,
  DeleteJobResult,
  DeleteProgressEvent,
} from "../types/delete.ts";
import { useSSE } from "./useSSE.ts";

interface StatusCounts {
  deleted: number;
  mismatch: number;
  failed: number;
  verified: number;
  verifying: number;
}

interface UseDeleteJobResult {
  startDelete: () => Promise<void>;
  cancelDelete: () => Promise<void>;
  filesProcessed: number;
  totalFiles: number;
  statusCounts: StatusCounts;
  totalDeletedSize: number;
  isRunning: boolean;
  isCancelling: boolean;
  jobStatus: string;
}

/** Type guard: is this a progress event? */
function isProgressEvent(
  data: Record<string, unknown>,
): data is DeleteProgressEvent & Record<string, unknown> {
  return data.type === "delete_progress";
}

/** Type guard: is this a completion event? */
function isCompleteEvent(
  data: Record<string, unknown>,
): data is DeleteCompleteEvent & Record<string, unknown> {
  return data.type === "delete_complete";
}

function extractCounts(counts: Record<string, number>): StatusCounts {
  return {
    deleted: counts.deleted ?? 0,
    mismatch: counts.mismatch ?? 0,
    failed: counts.failed ?? 0,
    verified: counts.verified ?? 0,
    verifying: counts.verifying ?? 0,
  };
}

export function useDeleteJob(): UseDeleteJobResult {
  const [isRunning, setIsRunning] = useState(false);
  const [filesProcessed, setFilesProcessed] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [statusCounts, setStatusCounts] = useState<StatusCounts>({
    deleted: 0,
    mismatch: 0,
    failed: 0,
    verified: 0,
    verifying: 0,
  });
  const [totalDeletedSize, setTotalDeletedSize] = useState(0);
  const [jobStatus, setJobStatus] = useState("pending");
  const [isCancelling, setIsCancelling] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const { deleteJobId, setCompletedJob, setIsDeleting } = useDeleteStore();

  const handleMessage = useCallback(
    (raw: unknown) => {
      const data = raw as Record<string, unknown>;
      if (!data || typeof data !== "object") return;

      if (isProgressEvent(data)) {
        const p = data as DeleteProgressEvent;
        setFilesProcessed(p.files_processed);
        setTotalFiles(p.total_files);
        setStatusCounts(extractCounts(p.status_counts));
        setTotalDeletedSize(p.total_deleted_size);
        setJobStatus(p.status);
        return;
      }

      if (isCompleteEvent(data)) {
        const c = data as DeleteCompleteEvent;
        setFilesProcessed(c.total_files);
        setTotalFiles(c.total_files);
        setStatusCounts(extractCounts(c.status_counts));
        setTotalDeletedSize(c.total_deleted_size);
        setJobStatus(c.status);
        setIsRunning(false);
        setIsCancelling(false);
        setIsDeleting(false);
        setActiveJobId(null);
        setCompletedJob(c as unknown as DeleteJobResult);
        return;
      }
    },
    [setCompletedJob, setIsDeleting],
  );

  const sseUrl = useMemo(
    () =>
      activeJobId && isRunning
        ? `/api/delete/progress/${activeJobId}`
        : null,
    [activeJobId, isRunning],
  );

  useSSE({
    url: sseUrl,
    onMessage: handleMessage,
    onError: () => {
      if (isRunning) {
        setIsRunning(false);
        setIsCancelling(false);
        setIsDeleting(false);
        setActiveJobId(null);
      }
    },
  });

  const startDelete = useCallback(async () => {
    if (!deleteJobId) return;

    setFilesProcessed(0);
    setStatusCounts({
      deleted: 0,
      mismatch: 0,
      failed: 0,
      verified: 0,
      verifying: 0,
    });
    setTotalDeletedSize(0);
    setJobStatus("verifying");
    setIsCancelling(false);
    setIsRunning(true);
    setIsDeleting(true);

    try {
      await apiPost(`/api/delete/start/${deleteJobId}`);
      setActiveJobId(deleteJobId);
    } catch {
      setIsRunning(false);
      setIsDeleting(false);
    }
  }, [deleteJobId, setIsDeleting]);

  /** Cancel the delete job. SSE terminal event handles cleanup. */
  const cancelDelete = useCallback(async () => {
    const jobId = useDeleteStore.getState().deleteJobId;
    if (!jobId) return;
    setIsCancelling(true);
    try {
      await apiPost(`/api/delete/cancel/${jobId}`);
    } catch {
      // If cancel request fails, force-close
      setIsRunning(false);
      setIsCancelling(false);
      setIsDeleting(false);
      setActiveJobId(null);
    }
  }, [setIsDeleting]);

  return {
    startDelete,
    cancelDelete,
    filesProcessed,
    totalFiles,
    statusCounts,
    totalDeletedSize,
    isRunning,
    isCancelling,
    jobStatus,
  };
}
