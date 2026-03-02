import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../api/client.ts";
import { usePagination } from "../../hooks/usePagination.ts";
import type { LogEntriesResponse, LogEntry } from "../../types/api.ts";
import SortableHeader from "../common/SortableHeader.tsx";
import type { LogFilters } from "./FilterBar.tsx";

const LEVEL_BADGES: Record<string, string> = {
  INFO: "bg-blue-100 text-blue-800",
  WARNING: "bg-yellow-100 text-yellow-800",
  ERROR: "bg-red-100 text-red-800",
};

function LevelBadge({ level }: { level: string }) {
  const classes = LEVEL_BADGES[level] ?? "bg-gray-100 text-gray-800";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${classes}`}>
      {level}
    </span>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

type SortColumn = "timestamp" | "level" | "category" | "event";

interface LogTableProps {
  filters: LogFilters;
}

export default function LogTable({ filters }: LogTableProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [sortColumn, setSortColumn] = useState<SortColumn>("timestamp");
  const [ascending, setAscending] = useState(false);

  const pagination = usePagination(50);
  const { offset, limit, setTotal, reset: paginationReset } = pagination;

  const toggleSort = useCallback(
    (column: SortColumn) => {
      if (column === sortColumn) {
        setAscending((prev) => !prev);
      } else {
        setSortColumn(column);
        setAscending(column === "timestamp" ? false : true);
      }
    },
    [sortColumn],
  );

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {
        offset: String(offset),
        limit: String(limit),
      };
      if (filters.date) params.date = filters.date;
      if (filters.level) params.level = filters.level;
      if (filters.category) params.category = filters.category;
      if (filters.search) params.search = filters.search;

      const data = await apiGet<LogEntriesResponse>("/api/logs/entries", params);
      setEntries(data.entries);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load log entries");
    } finally {
      setLoading(false);
    }
  }, [filters, offset, limit, setTotal]);

  // Reset to page 1 when filters change
  useEffect(() => {
    paginationReset();
  }, [filters.date, filters.level, filters.category, filters.search, paginationReset]);

  useEffect(() => {
    void fetchEntries();
  }, [fetchEntries]);

  // Client-side sort of the current page
  const sortedEntries = [...entries].sort((a, b) => {
    const aVal = a[sortColumn];
    const bVal = b[sortColumn];
    let cmp = 0;
    if (typeof aVal === "string" && typeof bVal === "string") {
      cmp = aVal.localeCompare(bVal);
    }
    return ascending ? cmp : -cmp;
  });

  const toggleExpand = (id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <SortableHeader
                label="Timestamp"
                active={sortColumn === "timestamp"}
                ascending={ascending}
                onSort={() => toggleSort("timestamp")}
              />
              <SortableHeader
                label="Level"
                active={sortColumn === "level"}
                ascending={ascending}
                onSort={() => toggleSort("level")}
              />
              <SortableHeader
                label="Category"
                active={sortColumn === "category"}
                ascending={ascending}
                onSort={() => toggleSort("category")}
              />
              <SortableHeader
                label="Event"
                active={sortColumn === "event"}
                ascending={ascending}
                onSort={() => toggleSort("event")}
              />
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Message
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && entries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-gray-500">
                  Loading log entries...
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-red-600">
                  {error}
                </td>
              </tr>
            ) : sortedEntries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-gray-500">
                  No log entries found.
                </td>
              </tr>
            ) : (
              sortedEntries.map((entry) => (
                <LogRow
                  key={entry.id}
                  entry={entry}
                  expanded={expandedId === entry.id}
                  onToggle={() => toggleExpand(entry.id)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
          <span className="text-sm text-gray-500">
            Page {pagination.currentPage} of {pagination.totalPages}
          </span>
          <div className="flex gap-2">
            <button
              onClick={pagination.prevPage}
              disabled={pagination.currentPage === 1}
              className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={pagination.nextPage}
              disabled={pagination.currentPage === pagination.totalPages}
              className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Single log row with expandable metadata */
function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasMetadata = entry.metadata && Object.keys(entry.metadata).length > 0;

  return (
    <>
      <tr
        className={`hover:bg-gray-50 transition-colors ${hasMetadata ? "cursor-pointer" : ""}`}
        onClick={hasMetadata ? onToggle : undefined}
      >
        <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
          {formatTimestamp(entry.timestamp)}
        </td>
        <td className="px-4 py-3">
          <LevelBadge level={entry.level} />
        </td>
        <td className="px-4 py-3 text-sm text-gray-600">{entry.category}</td>
        <td className="px-4 py-3 text-sm text-gray-700 font-mono text-xs">{entry.event}</td>
        <td className="px-4 py-3 text-sm text-gray-600 max-w-md truncate" title={entry.message}>
          <div className="flex items-center gap-2">
            <span className="truncate">{entry.message}</span>
            {hasMetadata && (
              <svg
                className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            )}
          </div>
        </td>
      </tr>
      {expanded && hasMetadata && (
        <tr>
          <td colSpan={5} className="px-4 py-3 bg-gray-50">
            <pre className="text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap font-mono bg-white p-3 rounded border border-gray-200">
              {JSON.stringify(entry.metadata, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
