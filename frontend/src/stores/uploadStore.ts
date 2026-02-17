import { create } from "zustand";
import type { ScannedFolder, UploadJob } from "../types/api.ts";

export type UploadStep = 1 | 2 | 3 | 4;

interface UploadState {
  // Current step
  step: UploadStep;
  setStep: (step: UploadStep) => void;

  // Selected folder
  folderPath: string;
  setFolderPath: (path: string) => void;

  // Scan results
  scanJobId: string | null;
  scanFolders: ScannedFolder[];
  scanComplete: boolean;
  isScanning: boolean;
  scanTotals: {
    totalFiles: number;
    alreadyUploaded: number;
    totalSize: number;
  };
  setScanJobId: (id: string | null) => void;
  addScanFolder: (folder: ScannedFolder) => void;
  setScanComplete: (complete: boolean) => void;
  setIsScanning: (scanning: boolean) => void;
  updateScanTotals: (totals: { totalFiles: number; alreadyUploaded: number; totalSize: number }) => void;

  // Upload job
  uploadJobId: string | null;
  completedJob: UploadJob | null;
  setUploadJobId: (id: string | null) => void;
  setCompletedJob: (job: UploadJob | null) => void;

  // Reset
  reset: () => void;
}

const initialState = {
  step: 1 as UploadStep,
  folderPath: "",
  scanJobId: null,
  scanFolders: [],
  scanComplete: false,
  isScanning: false,
  scanTotals: { totalFiles: 0, alreadyUploaded: 0, totalSize: 0 },
  uploadJobId: null,
  completedJob: null,
};

export const useUploadStore = create<UploadState>((set) => ({
  ...initialState,

  setStep: (step) => set({ step }),
  setFolderPath: (folderPath) => set({ folderPath }),

  setScanJobId: (scanJobId) => set({ scanJobId }),
  addScanFolder: (folder) =>
    set((s) => ({ scanFolders: [...s.scanFolders, folder] })),
  setScanComplete: (scanComplete) => set({ scanComplete }),
  setIsScanning: (isScanning) => set({ isScanning }),
  updateScanTotals: (scanTotals) => set({ scanTotals }),

  setUploadJobId: (uploadJobId) => set({ uploadJobId }),
  setCompletedJob: (completedJob) => set({ completedJob }),

  reset: () => set(initialState),
}));
