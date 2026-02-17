import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../api/client.ts";
import { useAppStore } from "../../stores/appStore.ts";
import type { CacheStats, CacheSyncResult } from "../../types/api.ts";

export default function CacheSection() {
  const { addNotification } = useAppStore();

  const [stats, setStats] = useState<CacheStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<CacheSyncResult | null>(null);

  async function loadStats() {
    setLoading(true);
    try {
      const data = await apiGet<CacheStats>("/api/settings/cache/stats");
      setStats(data);
    } catch {
      addNotification("error", "Failed to load cache statistics");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await apiPost<CacheSyncResult>("/api/settings/cache/sync");
      setSyncResult(result);
      if (result.success) {
        addNotification("success", "Cache synced with AWS");
        loadStats();
      } else {
        addNotification("error", result.error ?? "Cache sync failed");
      }
    } catch {
      addNotification("error", "Failed to sync cache");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold text-nlr-text mb-4">Upload Cache</h3>

      {loading ? (
        <p className="text-sm text-gray-500">Loading cache statistics...</p>
      ) : stats?.success ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
          <div className="bg-gray-50 rounded-md p-3">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Total Entries</div>
            <div className="text-lg font-semibold text-nlr-text mt-1">
              {stats.stats.total_entries.toLocaleString()}
            </div>
          </div>
          <div className="bg-gray-50 rounded-md p-3">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Exists</div>
            <div className="text-lg font-semibold text-nlr-green mt-1">
              {stats.stats.exists_count.toLocaleString()}
            </div>
          </div>
          <div className="bg-gray-50 rounded-md p-3">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Not Exists</div>
            <div className="text-lg font-semibold text-gray-500 mt-1">
              {stats.stats.not_exists_count.toLocaleString()}
            </div>
          </div>
          <div className="bg-gray-50 rounded-md p-3">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Bucket</div>
            <div className="text-sm font-mono text-nlr-text mt-1 truncate" title={stats.stats.bucket}>
              {stats.stats.bucket || "-"}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-500 mb-4">No cache data available.</p>
      )}

      {/* Sync result */}
      {syncResult?.success && (
        <div className="mb-4 p-3 rounded-md text-sm bg-green-50 text-green-800 border border-green-200">
          Synced: {syncResult.files_in_s3?.toLocaleString()} files in S3,{" "}
          {syncResult.files_updated?.toLocaleString()} updated,{" "}
          {syncResult.files_removed?.toLocaleString()} removed
        </div>
      )}

      <button
        type="button"
        onClick={handleSync}
        disabled={syncing}
        className="px-4 py-2 text-sm font-medium text-nlr-blue border border-nlr-blue rounded-md hover:bg-nlr-blue hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {syncing ? "Syncing..." : "Sync with AWS"}
      </button>
    </div>
  );
}
