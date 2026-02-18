/**
 * Hook for scanning a folder for deletable MCAP files.
 *
 * Calls POST /api/delete/scan and returns scanned files
 * that match entries in the upload cache.
 */

import { useCallback } from "react";

import { apiPost } from "../api/client.ts";
import { useDeleteStore } from "../stores/deleteStore.ts";
import type { DeleteScanResponse } from "../types/delete.ts";

interface ScanExclusions {
  subfolders: string[];
  files: string[];
}

interface UseDeleteScanResult {
  scan: (folderPath: string, exclusions?: ScanExclusions) => Promise<void>;
  isScanning: boolean;
}

export function useDeleteScan(): UseDeleteScanResult {
  const { isScanning, setIsScanning, setScanResults, setDeleteJobId } =
    useDeleteStore();

  const scan = useCallback(
    async (folderPath: string, exclusions?: ScanExclusions) => {
      setIsScanning(true);
      try {
        const body: Record<string, unknown> = { folder_path: folderPath };
        if (exclusions) {
          body.excluded_subfolders = exclusions.subfolders;
          body.excluded_files = exclusions.files;
        }
        const res = await apiPost<DeleteScanResponse>("/api/delete/scan", body);
        setDeleteJobId(res.job_id);
        setScanResults(res.files, res.total_size);
      } finally {
        setIsScanning(false);
      }
    },
    [setIsScanning, setScanResults, setDeleteJobId],
  );

  return { scan, isScanning };
}
