/**
 * Unified file table that persists across Review / Upload / Summary phases.
 *
 * Fixed 6-column grid — column content adapts per phase, but layout is stable.
 * Uses @tanstack/react-virtual for 20K+ file handling.
 */

import { memo, useCallback, useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { formatBytes } from "../../utils/format/bytes.ts";
import { formatDate } from "../../utils/format/date.ts";
import type {
  SortDir,
  SortKey,
  UnifiedFileRow,
  UnifiedStatus,
  UploadPhase,
} from "../../types/upload.ts";
// ── Grid template (fixed across all phases) ──

const GRID_COLS = "grid-cols-[36px_1fr_1fr_80px_120px_1fr]";
const ROW_HEIGHT = 40;

// ── Props ──

interface UnifiedFileTableProps {
  phase: UploadPhase;
  files: UnifiedFileRow[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  isSortFrozen: boolean;

  // Selection (review phase only)
  selectedPaths: Set<string>;
  onToggleFile: (path: string) => void;
  onToggleAllFiltered: () => void;
  headerChecked: boolean;
  headerIndeterminate: boolean;
}

export default function UnifiedFileTable({
  phase,
  files,
  sortKey,
  sortDir,
  onSort,
  isSortFrozen,
  selectedPaths,
  onToggleFile,
  onToggleAllFiltered,
  headerChecked,
  headerIndeterminate,
}: UnifiedFileTableProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Reset scroll when files change significantly (e.g., filter change)
  const prevCountRef = useRef(files.length);
  useEffect(() => {
    if (Math.abs(files.length - prevCountRef.current) > 100) {
      rowVirtualizer.scrollToIndex(0);
    }
    prevCountRef.current = files.length;
  }, [files.length, rowVirtualizer]);

  const scrollToActive = useCallback(() => {
    const idx = files.findIndex(
      (f) => f.status === "in_progress",
    );
    if (idx >= 0) {
      rowVirtualizer.scrollToIndex(idx, { align: "center" });
    }
  }, [files, rowVirtualizer]);

  // Count active files for the "jump to active" button
  const hasActiveFiles = phase === "uploading" && files.some((f) => f.status === "in_progress");

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden relative">
      {/* Header */}
      <div
        className={`grid ${GRID_COLS} gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs font-medium text-gray-500 uppercase tracking-wider`}
      >
        {/* Col 1: Checkbox / Status icon */}
        <div className="flex items-center justify-center">
          {phase === "review" ? (
            <IndeterminateCheckbox
              checked={headerChecked}
              indeterminate={headerIndeterminate}
              onChange={onToggleAllFiltered}
            />
          ) : (
            <span />
          )}
        </div>

        {/* Col 2: Filename */}
        <SortHeader
          label="Filename"
          sortKey="filename"
          currentKey={sortKey}
          dir={sortDir}
          onSort={onSort}
          disabled={isSortFrozen}
        />

        {/* Col 3: Folder */}
        <SortHeader
          label="Folder"
          sortKey="folder"
          currentKey={sortKey}
          dir={sortDir}
          onSort={onSort}
          disabled={isSortFrozen}
        />

        {/* Col 4: Size */}
        <SortHeader
          label="Size"
          sortKey="size"
          currentKey={sortKey}
          dir={sortDir}
          onSort={onSort}
          disabled={isSortFrozen}
          className="justify-end"
        />

        {/* Col 5: Status */}
        <SortHeader
          label="Status"
          sortKey="status"
          currentKey={sortKey}
          dir={sortDir}
          onSort={onSort}
          disabled={isSortFrozen}
          className="justify-center"
        />

        {/* Col 6: Detail (context-dependent) */}
        <div>
          {phase === "review" && "Modified"}
          {phase === "uploading" && ""}
          {phase === "summary" && "S3 Path"}
        </div>
      </div>

      {/* Virtualized rows */}
      {files.length === 0 ? (
        <div className="p-6 text-center text-gray-400 text-sm">
          No files match the current filter.
        </div>
      ) : (
        <div
          ref={scrollContainerRef}
          className="overflow-auto"
          style={{ height: Math.min(files.length * ROW_HEIGHT, 520) }}
        >
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const file = files[virtualRow.index]!;
              return (
                <FileRow
                  key={file.path}
                  row={file}
                  phase={phase}
                  isSelected={selectedPaths.has(file.path)}
                  onToggle={onToggleFile}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 text-xs text-gray-500">
        {files.length.toLocaleString()} file{files.length !== 1 ? "s" : ""}
      </div>

      {/* Jump to active button (upload phase only) */}
      {hasActiveFiles && (
        <button
          type="button"
          onClick={scrollToActive}
          className="absolute bottom-12 right-4 px-3 py-1.5 text-xs font-medium
            bg-nlr-blue text-white rounded-full shadow-lg hover:bg-blue-700
            transition-colors z-10"
        >
          Jump to active
        </button>
      )}
    </div>
  );
}

// ── Row component (memoized — new object ref on mutation triggers re-render) ──

interface FileRowProps {
  row: UnifiedFileRow;
  phase: UploadPhase;
  isSelected: boolean;
  onToggle: (path: string) => void;
  style: React.CSSProperties;
}

const FileRow = memo(function FileRow({
  row,
  phase,
  isSelected,
  onToggle,
  style,
}: FileRowProps) {
  return (
    <div
      className={`grid ${GRID_COLS} gap-2 px-4 items-center text-xs border-b border-gray-50 hover:bg-gray-50/50`}
      style={style}
    >
      {/* Col 1: Checkbox / Status icon */}
      <div className="flex items-center justify-center">
        {phase === "review" ? (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggle(row.path)}
            className="h-3.5 w-3.5 rounded border-gray-300 text-nlr-blue focus:ring-nlr-blue cursor-pointer"
          />
        ) : (
          <StatusIcon status={row.status} />
        )}
      </div>

      {/* Col 2: Filename */}
      <span className="text-gray-700 truncate" title={row.filename}>
        {row.filename}
      </span>

      {/* Col 3: Folder */}
      <span className="text-gray-500 truncate" title={row.folder}>
        {row.folder}
      </span>

      {/* Col 4: Size */}
      <span className="text-gray-500 text-right tabular-nums">
        {formatBytes(row.size)}
      </span>

      {/* Col 5: Status */}
      <div className="flex justify-center">
        <StatusBadge status={row.status} progressPercent={row.progressPercent} phase={phase} />
      </div>

      {/* Col 6: Detail */}
      <div className="text-gray-400 truncate">
        {phase === "review" && formatDate(row.mtime)}
        {phase === "uploading" && row.status === "in_progress" && (
          <MiniProgressBar percent={row.progressPercent} />
        )}
        {phase === "summary" && (
          <span title={row.s3Path}>{row.s3Path}</span>
        )}
      </div>
    </div>
  );
});

// ── Sub-components ──

function StatusIcon({ status }: { status: UnifiedStatus }) {
  switch (status) {
    case "in_progress":
      return (
        <svg className="w-4 h-4 text-nlr-blue spinner" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      );
    case "completed":
      return (
        <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      );
    case "failed":
      return (
        <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
        </svg>
      );
    case "skipped":
      return (
        <svg className="w-4 h-4 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14" />
        </svg>
      );
    default:
      // queued, new, already_uploaded
      return <span className="w-4 h-4 rounded-full border-2 border-gray-300 block" />;
  }
}

function StatusBadge({
  status,
  progressPercent,
  phase,
}: {
  status: UnifiedStatus;
  progressPercent: number;
  phase: UploadPhase;
}) {
  // Review phase: show "new" or "uploaded" based on status
  if (phase === "review") {
    if (status === "already_uploaded") {
      return (
        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-yellow-100 text-yellow-700 transition-colors duration-300">
          uploaded
        </span>
      );
    }
    return (
      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700 transition-colors duration-300">
        new
      </span>
    );
  }

  // Upload / Summary phase
  const styles: Record<string, string> = {
    queued: "bg-gray-100 text-gray-500",
    in_progress: "bg-blue-100 text-nlr-blue",
    completed: "bg-green-100 text-green-700",
    skipped: "bg-yellow-100 text-yellow-700",
    failed: "bg-red-100 text-red-700",
  };

  const labels: Record<string, string> = {
    queued: "queued",
    in_progress: `${Math.round(progressPercent)}%`,
    completed: "uploaded",
    skipped: "skipped",
    failed: "failed",
  };

  return (
    <span
      className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors duration-300 ${styles[status] ?? "bg-gray-100 text-gray-500"}`}
    >
      {labels[status] ?? status}
    </span>
  );
}

function MiniProgressBar({ percent }: { percent: number }) {
  return (
    <div className="w-full bg-gray-200 rounded-full h-1.5">
      <div
        className="bg-nlr-blue h-full rounded-full transition-all duration-300"
        style={{ width: `${Math.min(100, percent)}%` }}
      />
    </div>
  );
}

// ── Sortable column header ──

function SortHeader({
  label,
  sortKey,
  currentKey,
  dir,
  onSort,
  disabled = false,
  className = "",
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  disabled?: boolean;
  className?: string;
}) {
  const active = sortKey === currentKey;
  const arrow = active ? (dir === "asc" ? " \u2191" : " \u2193") : "";
  return (
    <button
      type="button"
      onClick={() => !disabled && onSort(sortKey)}
      disabled={disabled}
      className={`flex items-center gap-1 select-none
        ${disabled ? "cursor-default text-gray-400" : "hover:text-gray-700 cursor-pointer"}
        ${active && !disabled ? "text-gray-700" : ""}
        ${className}`}
    >
      {label}
      {arrow && <span className="text-nlr-blue">{arrow}</span>}
    </button>
  );
}

// ── Indeterminate checkbox ──

function IndeterminateCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="h-3.5 w-3.5 rounded border-gray-300 text-nlr-blue focus:ring-nlr-blue cursor-pointer"
    />
  );
}

