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

interface UseDeleteScanResult {
  scan: (folderPath: string) => Promise<void>;
  isScanning: boolean;
}

export function useDeleteScan(): UseDeleteScanResult {
  const { isScanning, setIsScanning, setScanResults, setDeleteJobId } =
    useDeleteStore();

  const scan = useCallback(
    async (folderPath: string) => {
      setIsScanning(true);
      try {
        const res = await apiPost<DeleteScanResponse>("/api/delete/scan", {
          folder_path: folderPath,
        });
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
