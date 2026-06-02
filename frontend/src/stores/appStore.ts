import { create } from 'zustand';
import { apiGet, apiPost, apiPut } from '../api/client.ts';
import type {
  AppSettings,
  BranchListResult,
  BranchSwitchResult,
  RollbackResult,
  UpdateCheckResult,
  VersionInfo,
} from '../types/api.ts';

export interface Notification {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
}

// How long an automatic update check stays fresh before we re-run `git fetch`.
const AUTO_UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const AUTO_UPDATE_CHECK_KEY = 'modaq.autoUpdateCheck';

interface CachedAutoCheck {
  ts: number;
  result: UpdateCheckResult;
  branchInfo: BranchListResult | null;
}

/** Return a still-fresh cached update check, or null to trigger a new fetch. */
function readCachedAutoCheck(): CachedAutoCheck | null {
  try {
    const raw = localStorage.getItem(AUTO_UPDATE_CHECK_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedAutoCheck;
    if (Date.now() - cached.ts > AUTO_UPDATE_CHECK_TTL_MS) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeCachedAutoCheck(
  result: UpdateCheckResult,
  branchInfo: BranchListResult | null,
): void {
  try {
    const payload: CachedAutoCheck = { ts: Date.now(), result, branchInfo };
    localStorage.setItem(AUTO_UPDATE_CHECK_KEY, JSON.stringify(payload));
  } catch {
    // Storage unavailable (private mode / quota) — skip caching, no harm.
  }
}

interface AppState {
  // Settings
  settings: AppSettings | null;
  settingsLoading: boolean;
  loadSettings: () => Promise<void>;
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>;

  // Version
  version: VersionInfo | null;
  loadVersion: () => Promise<void>;

  // Auto-update modal
  showUpdateModal: boolean;
  autoCheckDone: boolean;
  autoCheckResult: UpdateCheckResult | null;
  branchInfo: BranchListResult | null;
  openUpdateModal: () => void;
  closeUpdateModal: () => void;
  runAutoCheck: () => Promise<void>;
  switchBranch: (branch: string) => Promise<BranchSwitchResult>;
  refreshBranchInfo: () => Promise<void>;
  rollbackUpdate: (commit: string) => Promise<RollbackResult>;

  // Notifications
  notifications: Notification[];
  addNotification: (type: Notification['type'], message: string) => void;
  removeNotification: (id: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  // Settings
  settings: null,
  settingsLoading: false,

  loadSettings: async () => {
    set({ settingsLoading: true });
    try {
      const settings = await apiGet<AppSettings>('/api/settings');
      set({ settings, settingsLoading: false });
    } catch {
      set({ settingsLoading: false });
      get().addNotification('error', 'Failed to load settings');
    }
  },

  updateSettings: async (updates) => {
    try {
      const settings = await apiPut<AppSettings>('/api/settings', updates);
      set({ settings });
      get().addNotification('success', 'Settings saved');
    } catch {
      get().addNotification('error', 'Failed to save settings');
    }
  },

  // Version
  version: null,

  loadVersion: async () => {
    try {
      const version = await apiGet<VersionInfo>('/api/settings/version');
      set({ version });
    } catch {
      // Silently fail — version is non-critical
    }
  },

  // Auto-update modal
  showUpdateModal: false,
  autoCheckDone: false,
  autoCheckResult: null,
  branchInfo: null,

  openUpdateModal: () => set({ showUpdateModal: true }),
  closeUpdateModal: () => set({ showUpdateModal: false }),

  runAutoCheck: async () => {
    if (get().autoCheckDone) return;
    set({ autoCheckDone: true });

    // The update check runs `git fetch` server-side (seconds) and is purely
    // informational, so don't run it on every page load. Cache the result in
    // localStorage and only re-check once per AUTO_UPDATE_CHECK_TTL_MS. This
    // keeps it off the hot path of data pages like /files (which just needs to
    // list S3 objects).
    const cached = readCachedAutoCheck();
    if (cached) {
      set({ autoCheckResult: cached.result, branchInfo: cached.branchInfo });
      return;
    }

    try {
      const [checkResult, branchInfo] = await Promise.all([
        apiGet<UpdateCheckResult>('/api/settings/check-updates'),
        apiGet<BranchListResult>('/api/settings/branches'),
      ]);
      set({ autoCheckResult: checkResult, branchInfo });
      writeCachedAutoCheck(checkResult, branchInfo);
      // Only pop the modal automatically when an update is actually available
      if (checkResult.updates_available) {
        set({ showUpdateModal: true });
      }
    } catch {
      // Non-critical — silently fail
    }
  },

  switchBranch: async (branch: string) => {
    const result = await apiPost<BranchSwitchResult>('/api/settings/branches/switch', { branch });
    if (result.success) {
      set((s) => ({
        branchInfo: s.branchInfo ? { ...s.branchInfo, current: branch } : s.branchInfo,
      }));
    }
    return result;
  },

  refreshBranchInfo: async () => {
    try {
      const branchInfo = await apiGet<BranchListResult>('/api/settings/branches');
      set({ branchInfo });
    } catch {
      // Silently fail
    }
  },

  rollbackUpdate: async (commit: string) => {
    const result = await apiPost<RollbackResult>('/api/settings/rollback', { commit });
    return result;
  },

  // Notifications
  notifications: [],

  addNotification: (type, message) => {
    const id = crypto.randomUUID();
    set((s) => ({ notifications: [...s.notifications, { id, type, message }] }));
    // Auto-remove after 5 seconds
    setTimeout(() => get().removeNotification(id), 5000);
  },

  removeNotification: (id) => {
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) }));
  },
}));
