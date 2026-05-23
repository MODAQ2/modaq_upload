/**
 * Filter/search/selection toolbar for the review phase.
 *
 * During upload and summary phases, a simpler status filter bar is shown
 * instead (handled separately in UploadPage).
 */

import { useState } from "react";

import type { StatusFilter } from "../../types/upload.ts";

interface ReviewToolbarProps {
  statusFilter: StatusFilter;
  onStatusFilterChange: (f: StatusFilter) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  selectedCount: number;
  totalCount: number;
  filteredCount: number;
  showFilteredCount: boolean;

  // Selection actions
  onSelectAll: () => void;
  onSelectNewOnly: () => void;
  onToggleAllFiltered: () => void;
  onDeselectAll: () => void;
  onSelectFirstN: (n: number) => void;
  headerChecked: boolean;
}

export default function ReviewToolbar({
  statusFilter,
  onStatusFilterChange,
  searchQuery,
  onSearchChange,
  selectedCount,
  totalCount,
  filteredCount,
  showFilteredCount,
  onSelectAll,
  onSelectNewOnly,
  onToggleAllFiltered,
  onDeselectAll,
  onSelectFirstN,
  headerChecked,
}: ReviewToolbarProps) {
  const [selectFirstNInput, setSelectFirstNInput] = useState("");

  const handleSelectFirstN = () => {
    const n = Number.parseInt(selectFirstNInput, 10);
    if (Number.isNaN(n) || n <= 0) return;
    onSelectFirstN(n);
    setSelectFirstNInput("");
  };

  return (
    <div className="space-y-2">
      {/* Row 1: Filters + count */}
      <div className="flex items-center justify-between text-sm flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="status-filter" className="text-gray-600">
              Status:
            </label>
            <select
              id="status-filter"
              value={statusFilter}
              onChange={(e) => onStatusFilterChange(e.target.value as StatusFilter)}
              className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
            >
              <option value="all">All</option>
              <option value="new">Not Uploaded</option>
              <option value="uploaded">Already Uploaded</option>
            </select>
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search files..."
            className="border border-gray-300 rounded px-2 py-1 text-sm bg-white w-48"
          />
        </div>
        <div className="flex items-center gap-3 text-gray-500 text-sm">
          <span className="text-nlr-blue font-medium">
            {selectedCount.toLocaleString()} of {totalCount.toLocaleString()} selected
          </span>
          {showFilteredCount && (
            <span>({filteredCount.toLocaleString()} shown)</span>
          )}
        </div>
      </div>

      {/* Row 2: Selection actions */}
      <div className="flex items-center gap-4 text-xs flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-gray-400">Select:</span>
          <button type="button" onClick={onSelectAll} className="text-nlr-blue hover:underline">
            All
          </button>
          <span className="text-gray-300">|</span>
          <button type="button" onClick={onSelectNewOnly} className="text-nlr-blue hover:underline">
            Not Uploaded
          </button>
          <span className="text-gray-300">|</span>
          <button type="button" onClick={onToggleAllFiltered} className="text-nlr-blue hover:underline">
            {headerChecked ? "Deselect" : "Select"} Shown
          </button>
          <span className="text-gray-300">|</span>
          <button type="button" onClick={onDeselectAll} className="text-nlr-blue hover:underline">
            None
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-gray-400">Select first</span>
          <input
            type="number"
            min="1"
            value={selectFirstNInput}
            onChange={(e) => setSelectFirstNInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSelectFirstN(); }}
            placeholder="#"
            className="border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white w-16 tabular-nums"
          />
          <button
            type="button"
            onClick={handleSelectFirstN}
            disabled={!selectFirstNInput || Number.parseInt(selectFirstNInput, 10) <= 0}
            className="text-nlr-blue hover:underline disabled:text-gray-300 disabled:no-underline"
          >
            Go
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Simplified status filter for upload/summary phases.
 * Shows a dropdown to filter by upload status.
 */
export function StatusFilterBar({
  filter,
  onFilterChange,
  totalCount,
  filteredCount,
  searchQuery,
  onSearchChange,
}: {
  filter: StatusFilter;
  onFilterChange: (f: StatusFilter) => void;
  totalCount: number;
  filteredCount: number;
  searchQuery: string;
  onSearchChange: (q: string) => void;
}) {
  return (
    <div className="flex items-center justify-between text-sm flex-wrap gap-2">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="upload-status-filter" className="text-gray-600">
            Show:
          </label>
          <select
            id="upload-status-filter"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value as StatusFilter)}
            className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
          >
            <option value="all">All Files</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Uploaded</option>
            <option value="skipped">Skipped</option>
            <option value="failed">Failed</option>
            <option value="queued">Queued</option>
          </select>
        </div>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search files..."
          className="border border-gray-300 rounded px-2 py-1 text-sm bg-white w-48"
        />
      </div>
      {filteredCount !== totalCount && (
        <span className="text-gray-500 text-sm">
          {filteredCount.toLocaleString()} of {totalCount.toLocaleString()} shown
        </span>
      )}
    </div>
  );
}
