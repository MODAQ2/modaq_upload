import { create } from "zustand";
import type { DeleteJobResult, DeleteScanFile } from "../types/delete.ts";

export type DeleteStep = 1 | 2 | 3 | 4 | 5;

interface DeleteState {
  // Current step
  step: DeleteStep;
  setStep: (step: DeleteStep) => void;

  // Selected folder
  folderPath: string;
  setFolderPath: (path: string) => void;

  // Scan results
  scanResults: DeleteScanFile[];
  scanTotalSize: number;
  permissionWarning: boolean;
  isScanning: boolean;
  setScanResults: (
    files: DeleteScanFile[],
    totalSize: number,
    permissionWarning: boolean,
  ) => void;
  setPermissionWarning: (warning: boolean) => void;
  setIsScanning: (scanning: boolean) => void;

  // Delete job
  deleteJobId: string | null;
  completedJob: DeleteJobResult | null;
  isDeleting: boolean;
  setDeleteJobId: (id: string | null) => void;
  setCompletedJob: (job: DeleteJobResult | null) => void;
  setIsDeleting: (deleting: boolean) => void;

  // Reset
  reset: () => void;
}

const initialState = {
  step: 1 as DeleteStep,
  folderPath: "",
  scanResults: [] as DeleteScanFile[],
  scanTotalSize: 0,
  permissionWarning: false,
  isScanning: false,
  deleteJobId: null,
  completedJob: null,
  isDeleting: false,
};

export const useDeleteStore = create<DeleteState>((set) => ({
  ...initialState,

  setStep: (step) => set({ step }),
  setFolderPath: (folderPath) => set({ folderPath }),

  setScanResults: (scanResults, scanTotalSize, permissionWarning) =>
    set({ scanResults, scanTotalSize, permissionWarning }),
  setPermissionWarning: (permissionWarning) => set({ permissionWarning }),
  setIsScanning: (isScanning) => set({ isScanning }),

  setDeleteJobId: (deleteJobId) => set({ deleteJobId }),
  setCompletedJob: (completedJob) => set({ completedJob }),
  setIsDeleting: (isDeleting) => set({ isDeleting }),

  reset: () => set(initialState),
}));
