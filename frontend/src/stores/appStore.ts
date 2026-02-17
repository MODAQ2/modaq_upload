import { create } from "zustand";
import { apiGet, apiPut } from "../api/client.ts";
import type { AppSettings, VersionInfo } from "../types/api.ts";

export interface Notification {
  id: string;
  type: "success" | "error" | "info" | "warning";
  message: string;
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

  // Notifications
  notifications: Notification[];
  addNotification: (type: Notification["type"], message: string) => void;
  removeNotification: (id: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  // Settings
  settings: null,
  settingsLoading: false,

  loadSettings: async () => {
    set({ settingsLoading: true });
    try {
      const settings = await apiGet<AppSettings>("/api/settings");
      set({ settings, settingsLoading: false });
    } catch {
      set({ settingsLoading: false });
      get().addNotification("error", "Failed to load settings");
    }
  },

  updateSettings: async (updates) => {
    try {
      const settings = await apiPut<AppSettings>("/api/settings", updates);
      set({ settings });
      get().addNotification("success", "Settings saved");
    } catch {
      get().addNotification("error", "Failed to save settings");
    }
  },

  // Version
  version: null,

  loadVersion: async () => {
    try {
      const version = await apiGet<VersionInfo>("/api/settings/version");
      set({ version });
    } catch {
      // Silently fail — version is non-critical
    }
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
