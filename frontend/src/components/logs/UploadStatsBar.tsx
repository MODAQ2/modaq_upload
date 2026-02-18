import { useEffect, useState } from "react";
import { apiGet } from "../../api/client.ts";
import type { UploadStatsResponse } from "../../types/api.ts";
import StatCard from "../common/StatCard.tsx";

interface UploadStatsBarProps {
  onDataLoaded?: (data: UploadStatsResponse) => void;
}

export default function UploadStatsBar({ onDataLoaded }: UploadStatsBarProps) {
  const [stats, setStats] = useState<UploadStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchStats() {
      try {
        const data = await apiGet<UploadStatsResponse>("/api/logs/upload-stats");
        setStats(data);
        onDataLoaded?.(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load upload stats");
      }
    }
    void fetchStats();
  }, [onDataLoaded]);

  if (error) {
    return (
      <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">
        {error}
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white rounded-lg shadow-sm border-l-4 border-gray-200 p-4 animate-pulse">
            <div className="h-8 bg-gray-200 rounded w-16 mb-2" />
            <div className="h-4 bg-gray-100 rounded w-24" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <StatCard
        value={stats.total_files_uploaded.toLocaleString()}
        label="Files Uploaded"
        color="text-nlr-blue"
      />
      <StatCard
        value={stats.total_bytes_uploaded_formatted}
        label="Data Uploaded"
        color="text-nlr-green"
      />
      <StatCard
        value={stats.total_files_failed.toLocaleString()}
        label="Failed"
        color="text-red-500"
      />
      <StatCard
        value={stats.total_sessions.toLocaleString()}
        label="Upload Sessions"
        color="text-gray-600"
      />
    </div>
  );
}
