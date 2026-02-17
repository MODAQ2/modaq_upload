/**
 * Hook that wraps the scan-folder-async API + SSE progress stream.
 *
 * Starts a scan via POST, then listens on the SSE progress endpoint.
 * Updates uploadStore with scan results as they arrive.
 */

import { useCallback, useMemo, useState } from "react";

import { apiPost } from "../api/client.ts";
import { useUploadStore } from "../stores/uploadStore.ts";
import type {
  ScannedFolder,
  ScanEvent,
  ScanFolderCompleteEvent,
  ScanCompleteEvent,
} from "../types/api.ts";
import { useSSE } from "./useSSE.ts";

interface ScanTotals {
  totalFiles: number;
  alreadyUploaded: number;
  totalSize: number;
}

interface ScanExclusions {
  subfolders: string[];
  files: string[];
}

interface UseFolderScanResult {
  startScan: (folderPath: string, cacheOnly?: boolean, exclusions?: ScanExclusions) => Promise<void>;
  cancelScan: () => Promise<void>;
  folders: ScannedFolder[];
  isScanning: boolean;
  scanComplete: boolean;
  totals: ScanTotals;
}

export function useFolderScan(): UseFolderScanResult {
  const [jobId, setJobId] = useState<string | null>(null);

  const {
    scanFolders: folders,
    isScanning,
    scanComplete,
    scanTotals: totals,
    setScanJobId,
    addScanFolder,
    setScanComplete,
    setIsScanning,
    updateScanTotals,
  } = useUploadStore();

  /** Handle each SSE event from the scan stream. */
  const handleMessage = useCallback(
    (raw: unknown) => {
      const data = raw as ScanEvent & Record<string, unknown>;
      if (!data || typeof data !== "object") return;

      switch (data.type) {
        case "scan_started":
          // Just update scanning state — we already set it in startScan.
          break;

        case "scan_folder_complete": {
          const evt = data as ScanFolderCompleteEvent;
          addScanFolder(evt.folder);
          updateScanTotals({
            totalFiles: evt.running_totals.total_files_found,
            alreadyUploaded: evt.running_totals.total_already_uploaded,
            totalSize: evt.running_totals.total_size,
          });
          break;
        }

        case "scan_complete": {
          const evt = data as ScanCompleteEvent;
          updateScanTotals({
            totalFiles: evt.total_files_found,
            alreadyUploaded: evt.total_already_uploaded,
            totalSize: evt.total_size,
          });
          setScanComplete(true);
          setIsScanning(false);
          setJobId(null);
          break;
        }
      }
    },
    [addScanFolder, updateScanTotals, setScanComplete, setIsScanning],
  );

  // Only connect when we have a jobId and are still scanning.
  const sseUrl = useMemo(
    () => (jobId && isScanning ? `/api/upload/progress/${jobId}` : null),
    [jobId, isScanning],
  );

  useSSE({
    url: sseUrl,
    onMessage: handleMessage,
    onError: () => {
      // Stream ended or errored — mark complete if not already.
      if (isScanning) {
        setScanComplete(true);
        setIsScanning(false);
        setJobId(null);
      }
    },
  });

  /** Kick off a new folder scan. */
  const startScan = useCallback(
    async (folderPath: string, cacheOnly = false, exclusions?: ScanExclusions) => {
      setIsScanning(true);
      setScanComplete(false);

      try {
        const body: Record<string, unknown> = {
          folder_path: folderPath,
          cache_only: cacheOnly,
        };
        if (exclusions) {
          body.excluded_subfolders = exclusions.subfolders;
          body.excluded_files = exclusions.files;
        }
        const res = await apiPost<{ job_id: string }>("/api/upload/scan-folder-async", body);
        setScanJobId(res.job_id);
        setJobId(res.job_id);
      } catch {
        setIsScanning(false);
        setScanComplete(false);
      }
    },
    [setScanJobId, setIsScanning, setScanComplete],
  );

  /** Cancel an in-progress scan. */
  const cancelScan = useCallback(async () => {
    const currentJobId = useUploadStore.getState().scanJobId;
    if (currentJobId) {
      try {
        await apiPost(`/api/upload/cancel/${currentJobId}`);
      } catch {
        // Ignore — may already be done.
      }
    }
    setIsScanning(false);
    setScanComplete(false);
    setJobId(null);
  }, [setIsScanning, setScanComplete]);

  return { startScan, cancelScan, folders, isScanning, scanComplete, totals };
}
