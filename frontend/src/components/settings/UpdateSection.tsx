import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../api/client.ts";
import { useAppStore } from "../../stores/appStore.ts";
import type { UpdateCheckResult, UpdateResult } from "../../types/api.ts";

export default function UpdateSection() {
  const { version, loadVersion, addNotification } = useAppStore();

  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateResult | null>(null);

  useEffect(() => {
    loadVersion();
  }, [loadVersion]);

  async function handleCheckUpdates() {
    setChecking(true);
    setCheckResult(null);
    try {
      const result = await apiGet<UpdateCheckResult>("/api/settings/check-updates");
      setCheckResult(result);
    } catch {
      addNotification("error", "Failed to check for updates");
    } finally {
      setChecking(false);
    }
  }

  async function handleUpdate() {
    setUpdating(true);
    setUpdateResult(null);
    try {
      const result = await apiPost<UpdateResult>("/api/settings/update");
      setUpdateResult(result);
      if (result.success) {
        addNotification("success", "Application updated successfully");
        loadVersion();
      } else {
        addNotification("warning", "Update completed with some errors");
      }
    } catch {
      addNotification("error", "Failed to update application");
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold text-nlr-text mb-4">Application Updates</h3>

      {/* Version info grid */}
      {version && (
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="bg-gray-50 rounded-md p-3">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Version</div>
            <div className="text-sm font-mono font-medium text-nlr-text mt-1">
              {version.version}
            </div>
          </div>
          <div className="bg-gray-50 rounded-md p-3">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Commit</div>
            <div className="text-sm font-mono font-medium text-nlr-text mt-1">
              {version.commit.slice(0, 7)}
              {version.dirty && <span className="text-nlr-yellow ml-1">(dirty)</span>}
            </div>
          </div>
          <div className="bg-gray-50 rounded-md p-3">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Branch</div>
            <div className="text-sm font-mono font-medium text-nlr-text mt-1">
              {version.branch}
            </div>
          </div>
        </div>
      )}

      {/* Update check result */}
      {checkResult && (
        <div
          className={`mb-4 p-3 rounded-md text-sm ${
            checkResult.updates_available
              ? "bg-nlr-yellow/10 text-nlr-text border border-nlr-yellow/30"
              : "bg-green-50 text-green-800 border border-green-200"
          }`}
        >
          {checkResult.updates_available
            ? `${checkResult.commits_behind} commit${checkResult.commits_behind !== 1 ? "s" : ""} behind remote`
            : "Up to date"}
        </div>
      )}

      {/* Update result log */}
      {updateResult && (
        <div className="mb-4 bg-gray-900 text-gray-100 rounded-md p-4 text-sm font-mono overflow-auto max-h-64">
          {Object.entries(updateResult.results).map(([step, result]) => (
            <div key={step} className="mb-3 last:mb-0">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                    result.success
                      ? "bg-green-600 text-white"
                      : "bg-red-600 text-white"
                  }`}
                >
                  {result.success ? "OK" : "FAIL"}
                </span>
                <span className="text-gray-300">{step}</span>
              </div>
              <pre className="text-xs text-gray-400 whitespace-pre-wrap pl-4">
                {result.output || "(no output)"}
              </pre>
            </div>
          ))}
        </div>
      )}

      {/* Buttons */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleCheckUpdates}
          disabled={checking}
          className="px-4 py-2 text-sm font-medium text-nlr-blue border border-nlr-blue rounded-md hover:bg-nlr-blue hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {checking ? "Checking..." : "Check for Updates"}
        </button>

        {checkResult?.updates_available && (
          <button
            type="button"
            onClick={handleUpdate}
            disabled={updating}
            className="px-4 py-2 text-sm font-medium text-white bg-nlr-green rounded-md hover:bg-nlr-green-light disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {updating ? "Updating..." : "Update Application"}
          </button>
        )}
      </div>
    </div>
  );
}
