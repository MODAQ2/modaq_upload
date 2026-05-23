import type { BatchState, ScannedFolder, UploadJob } from '../types/api.ts';
import { createJobStore } from './createJobStore.ts';

export type UploadStep = 1 | 2 | 3 | 4;

interface UploadExtra {
  // Scan results
  scanJobId: string | null;
  scanFolders: ScannedFolder[];
  scanComplete: boolean;
  isScanning: boolean;
  scanFoldersTotal: number;
  scanTotals: {
    totalFiles: number;
    alreadyUploaded: number;
    totalSize: number;
  };
  setScanJobId: (id: string | null) => void;
  addScanFolder: (folder: ScannedFolder) => void;
  clearScanFolders: () => void;
  setScanComplete: (complete: boolean) => void;
  setIsScanning: (scanning: boolean) => void;
  setScanFoldersTotal: (total: number) => void;
  updateScanTotals: (totals: {
    totalFiles: number;
    alreadyUploaded: number;
    totalSize: number;
  }) => void;

  // Upload job
  uploadJobId: string | null;
  completedJob: UploadJob | null;
  setUploadJobId: (id: string | null) => void;
  setCompletedJob: (job: UploadJob | null) => void;

  // Batch processing state
  currentBatch: number | null;
  totalBatches: number | null;
  batchState: BatchState | null;
  isBatchProcessing: boolean;
  setCurrentBatch: (batch: number | null) => void;
  setTotalBatches: (batches: number | null) => void;
  setBatchState: (state: BatchState | null) => void;
  setIsBatchProcessing: (processing: boolean) => void;
}

const initialExtra: UploadExtra = {
  scanJobId: null,
  scanFolders: [],
  scanComplete: false,
  isScanning: false,
  scanFoldersTotal: 0,
  scanTotals: { totalFiles: 0, alreadyUploaded: 0, totalSize: 0 },
  uploadJobId: null,
  completedJob: null,
  currentBatch: null,
  totalBatches: null,
  batchState: null,
  isBatchProcessing: false,
  // placeholder setters — overridden by extraSlice
  setScanJobId: () => {},
  addScanFolder: () => {},
  clearScanFolders: () => {},
  setScanComplete: () => {},
  setIsScanning: () => {},
  setScanFoldersTotal: () => {},
  updateScanTotals: () => {},
  setUploadJobId: () => {},
  setCompletedJob: () => {},
  setCurrentBatch: () => {},
  setTotalBatches: () => {},
  setBatchState: () => {},
  setIsBatchProcessing: () => {},
};

export const useUploadStore = createJobStore<UploadStep, UploadExtra>(
  1 as UploadStep,
  initialExtra,
  (set) => ({
    ...initialExtra,

    setScanJobId: (scanJobId) => set({ scanJobId }),
    addScanFolder: (folder) => set((s) => ({ scanFolders: [...s.scanFolders, folder] })),
    clearScanFolders: () => set({ scanFolders: [] }),
    setScanComplete: (scanComplete) => set({ scanComplete }),
    setIsScanning: (isScanning) => set({ isScanning }),
    setScanFoldersTotal: (scanFoldersTotal) => set({ scanFoldersTotal }),
    updateScanTotals: (scanTotals) => set({ scanTotals }),

    setUploadJobId: (uploadJobId) => set({ uploadJobId }),
    setCompletedJob: (completedJob) => set({ completedJob }),

    setCurrentBatch: (currentBatch) => set({ currentBatch }),
    setTotalBatches: (totalBatches) => set({ totalBatches }),
    setBatchState: (batchState) => set({ batchState }),
    setIsBatchProcessing: (isBatchProcessing) => set({ isBatchProcessing }),
  }),
);
