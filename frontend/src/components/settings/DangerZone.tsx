import { useState } from "react";
import { apiPost } from "../../api/client.ts";
import { useAppStore } from "../../stores/appStore.ts";

const DEFAULT_SETTINGS = {
  aws_profile: "default",
  aws_region: "us-west-2",
  s3_bucket: "",
  default_upload_folder: "",
  display_name: "",
  log_directory: "logs",
};

export default function DangerZone() {
  const { updateSettings, addNotification } = useAppStore();

  const [clearing, setClearing] = useState(false);
  const [resetting, setResetting] = useState(false);

  async function handleClearCache() {
    if (!window.confirm("Are you sure you want to clear the upload cache? This cannot be undone.")) {
      return;
    }

    setClearing(true);
    try {
      const result = await apiPost<{ success: boolean; deleted: number; message: string }>(
        "/api/settings/cache/invalidate",
      );
      if (result.success) {
        addNotification("success", `Cleared ${result.deleted} cache entries`);
      } else {
        addNotification("error", "Failed to clear cache");
      }
    } catch {
      addNotification("error", "Failed to clear cache");
    } finally {
      setClearing(false);
    }
  }

  async function handleResetSettings() {
    if (
      !window.confirm(
        "Are you sure you want to reset all settings to defaults? This cannot be undone.",
      )
    ) {
      return;
    }

    setResetting(true);
    try {
      await updateSettings(DEFAULT_SETTINGS);
      addNotification("info", "Settings reset to defaults");
    } catch {
      addNotification("error", "Failed to reset settings");
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="bg-white rounded-lg shadow p-6 border-2 border-red-300">
      <h3 className="text-lg font-semibold text-red-600 mb-2">Danger Zone</h3>
      <p className="text-sm text-gray-500 mb-4">
        These actions are destructive and cannot be undone.
      </p>

      <div className="space-y-3">
        <div className="flex items-center justify-between p-3 rounded-md border border-red-200 bg-red-50/50">
          <div>
            <div className="text-sm font-medium text-nlr-text">Clear Upload Cache</div>
            <div className="text-xs text-gray-500">
              Removes all cached duplicate-check entries for the current bucket.
            </div>
          </div>
          <button
            type="button"
            onClick={handleClearCache}
            disabled={clearing}
            className="ml-4 px-4 py-2 text-sm font-medium text-red-600 border border-red-300 rounded-md hover:bg-red-600 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            {clearing ? "Clearing..." : "Clear Cache"}
          </button>
        </div>

        <div className="flex items-center justify-between p-3 rounded-md border border-red-200 bg-red-50/50">
          <div>
            <div className="text-sm font-medium text-nlr-text">Reset Settings</div>
            <div className="text-xs text-gray-500">
              Restores all settings to their default values.
            </div>
          </div>
          <button
            type="button"
            onClick={handleResetSettings}
            disabled={resetting}
            className="ml-4 px-4 py-2 text-sm font-medium text-red-600 border border-red-300 rounded-md hover:bg-red-600 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            {resetting ? "Resetting..." : "Reset Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}
