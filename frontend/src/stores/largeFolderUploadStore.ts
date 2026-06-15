import { create } from 'zustand';

export type SyncPhase = 'setup' | 'running' | 'done';
export type SyncStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface SyncProgress {
  done: number;
  total: number;
  elapsedS: number;
  etaS: number | null;
}

interface LargeFolderUploadState {
  phase: SyncPhase;
  jobId: string | null;
  s3Uri: string | null;
  cmd: string | null;
  folderPath: string | null;
  s3Prefix: string;
  lines: string[];
  status: SyncStatus | null;
  returnCode: number | null;
  error: string | null;
  progress: SyncProgress | null;
  /** Wall-clock ms when the real upload (post-dry-run) started. */
  uploadStartMs: number | null;
  /** Total elapsed seconds when the job finished, for the done screen. */
  completedElapsedS: number | null;

  setFolderPath: (path: string) => void;
  setS3Prefix: (prefix: string) => void;
  startJob: (jobId: string, s3Uri: string, cmd: string) => void;
  appendLine: (line: string) => void;
  setProgress: (p: SyncProgress) => void;
  setUploadStartMs: (ms: number) => void;
  finish: (status: SyncStatus, returnCode: number | null) => void;
  setError: (error: string) => void;
  reset: () => void;
}

export function defaultPrefix(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `user_upload_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

const initialState = {
  phase: 'setup' as SyncPhase,
  jobId: null,
  s3Uri: null,
  cmd: null,
  folderPath: null,
  s3Prefix: '',
  lines: [],
  status: null,
  returnCode: null,
  error: null,
  progress: null,
  uploadStartMs: null,
  completedElapsedS: null,
};

export const useLargeFolderUploadStore = create<LargeFolderUploadState>((set, get) => ({
  ...initialState,

  setFolderPath: (path) => set({ folderPath: path }),
  setS3Prefix: (prefix) => set({ s3Prefix: prefix }),

  startJob: (jobId, s3Uri, cmd) =>
    set({
      jobId,
      s3Uri,
      cmd,
      phase: 'running',
      lines: [],
      status: 'running',
      error: null,
      progress: null,
      uploadStartMs: null,
      completedElapsedS: null,
    }),

  appendLine: (line) => set((s) => ({ lines: [...s.lines, line] })),

  setProgress: (progress) => set({ progress }),

  setUploadStartMs: (ms) => set({ uploadStartMs: ms }),

  finish: (status, returnCode) => {
    const { uploadStartMs } = get();
    const completedElapsedS =
      uploadStartMs != null ? Math.round((Date.now() - uploadStartMs) / 1000) : null;
    set({ phase: 'done', status, returnCode, completedElapsedS });
  },

  setError: (error) => set({ error, phase: 'done', status: 'failed' }),

  reset: () => set({ ...initialState }),
}));
