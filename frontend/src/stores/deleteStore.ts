import type { DeleteJobResult, DeleteScanFile } from '../types/delete.ts';
import { createJobStore } from './createJobStore.ts';

export type DeleteStep = 1 | 2 | 3 | 4 | 5;

interface DeleteExtra {
  // Scan results
  scanResults: DeleteScanFile[];
  scanTotalSize: number;
  permissionWarning: boolean;
  isScanning: boolean;
  setScanResults: (files: DeleteScanFile[], totalSize: number, permissionWarning: boolean) => void;
  setPermissionWarning: (warning: boolean) => void;
  setIsScanning: (scanning: boolean) => void;

  // Delete job
  deleteJobId: string | null;
  completedJob: DeleteJobResult | null;
  isDeleting: boolean;
  setDeleteJobId: (id: string | null) => void;
  setCompletedJob: (job: DeleteJobResult | null) => void;
  setIsDeleting: (deleting: boolean) => void;
}

const initialExtra: DeleteExtra = {
  scanResults: [],
  scanTotalSize: 0,
  permissionWarning: false,
  isScanning: false,
  deleteJobId: null,
  completedJob: null,
  isDeleting: false,
  // placeholder setters — overridden by extraSlice
  setScanResults: () => {},
  setPermissionWarning: () => {},
  setIsScanning: () => {},
  setDeleteJobId: () => {},
  setCompletedJob: () => {},
  setIsDeleting: () => {},
};

export const useDeleteStore = createJobStore<DeleteStep, DeleteExtra>(
  1 as DeleteStep,
  initialExtra,
  (set) => ({
    ...initialExtra,

    setScanResults: (scanResults, scanTotalSize, permissionWarning) =>
      set({ scanResults, scanTotalSize, permissionWarning }),
    setPermissionWarning: (permissionWarning) => set({ permissionWarning }),
    setIsScanning: (isScanning) => set({ isScanning }),

    setDeleteJobId: (deleteJobId) => set({ deleteJobId }),
    setCompletedJob: (completedJob) => set({ completedJob }),
    setIsDeleting: (isDeleting) => set({ isDeleting }),
  }),
);
