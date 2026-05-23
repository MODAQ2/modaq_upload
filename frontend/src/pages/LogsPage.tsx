import { useCallback, useState } from "react";
import FilterBar from "../components/logs/FilterBar.tsx";
import type { LogFilters } from "../components/logs/FilterBar.tsx";
import LogStatsBar from "../components/logs/LogStatsBar.tsx";
import LogTable from "../components/logs/LogTable.tsx";
import UploadSessionList from "../components/logs/UploadSessionList.tsx";
import UploadStatsBar from "../components/logs/UploadStatsBar.tsx";
import type { UploadSession, UploadStatsResponse } from "../types/api.ts";

type ActiveTab = "uploads" | "events";

const DEFAULT_FILTERS: LogFilters = {
  date: "",
  level: "",
  category: "",
  search: "",
};

const tabs: { key: ActiveTab; label: string }[] = [
  { key: "uploads", label: "Upload History" },
  { key: "events", label: "Event Log" },
];

export default function LogsPage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("uploads");
  const [filters, setFilters] = useState<LogFilters>(DEFAULT_FILTERS);
  const [sessions, setSessions] = useState<UploadSession[]>([]);

  const handleUploadDataLoaded = useCallback((data: UploadStatsResponse) => {
    setSessions(data.sessions);
  }, []);

  const handleFilterChange = useCallback((newFilters: LogFilters) => {
    setFilters(newFilters);
  }, []);

  const title = activeTab === "uploads" ? "Upload History" : "Event Log";

  return (
    <div>
      <h2 className="text-xl font-semibold text-nlr-text mb-4">{title}</h2>

      {/* Tab bar */}
      <div className="flex border-b border-gray-200 mb-6">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors -mb-px ${
              activeTab === tab.key
                ? "text-nlr-blue border-b-2 border-nlr-blue"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Upload History tab */}
      {activeTab === "uploads" && (
        <div className="space-y-6">
          <UploadStatsBar onDataLoaded={handleUploadDataLoaded} />
          <UploadSessionList sessions={sessions} />
        </div>
      )}

      {/* Event Log tab */}
      {activeTab === "events" && (
        <div className="space-y-6">
          <LogStatsBar />
          <FilterBar onFilterChange={handleFilterChange} />
          <LogTable filters={filters} />
        </div>
      )}
    </div>
  );
}
