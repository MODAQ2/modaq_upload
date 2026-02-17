/**
 * Step 1: Filesystem browser for selecting a folder of MCAP files.
 *
 * Fetches `GET /api/files/browse?path=...` and renders:
 * - Quick links sidebar
 * - Breadcrumb navigation
 * - Summary bar with file counts + upload button (top, always visible)
 * - Folder list with upload progress indicators
 * - MCAP file list with clear uploaded/new status
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiGet } from "../../api/client.ts";
import type { BrowseResponse, LocalFile, LocalFolder } from "../../types/api.ts";
import { formatBytes } from "../../utils/format/bytes.ts";
import { formatDate } from "../../utils/format/date.ts";
import Breadcrumb from "../common/Breadcrumb.tsx";
import Spinner from "../common/Spinner.tsx";
import {
  FolderIcon,
  FileIcon,
  ChevronRightIcon,
  CheckIcon,
  PlusIcon,
  UploadIcon,
} from "../../utils/icons.tsx";

type FileSortKey = "filename" | "size" | "mtime" | "status";
type FileSortDir = "asc" | "desc";

export type BrowserMode = "upload" | "delete";

export interface FolderExclusions {
  subfolders: string[];
  files: string[];
}

interface FolderBrowserProps {
  onFolderSelected: (folderPath: string, exclusions?: FolderExclusions) => void;
  initialPath?: string;
  /** Controls wording, colors, and which files are emphasised. Default: "upload". */
  mode?: BrowserMode;
}

/** Mode-dependent text and styling. */
const modeConfig = {
  upload: {
    title: "Select Folder to Upload",
    subtitle: "Browse to a folder containing MCAP files.",
    details: "",
    /** Stat chip shown for the "actionable" count (new files for upload). */
    actionableLabel: "not uploaded",
    actionableColor: "green" as const,
    actionableIcon: "plus" as const,
    /** Stat chip shown for the "other" count (already uploaded). */
    otherLabel: "already uploaded",
    otherColor: "gray" as const,
    otherIcon: "check" as const,
    /** Action button wording — count is the "actionable" file count. */
    buttonLabel: (count: number) =>
      count > 0 ? `Upload ${count.toLocaleString()} file${count !== 1 ? "s" : ""}` : "Upload This Folder",
    buttonColor: "bg-nlr-blue text-white hover:bg-blue-700",
    /** For folders: dim when ALL files are already uploaded (nothing to upload). */
    dimFolder: (allUploaded: boolean, _noneUploaded: boolean) => allUploaded,
    /** For file rows: dim files that are already uploaded. */
    dimFile: (uploaded: boolean) => uploaded,
    /** Status badge for "uploaded" files. */
    uploadedBadge: { bg: "bg-green-50 text-green-700 border-green-200", label: "Uploaded" },
    /** Status badge for "not uploaded" files. */
    notUploadedBadge: { bg: "bg-amber-50 text-amber-700 border-amber-200", label: "Not Uploaded" },
  },
  delete: {
    title: "Select Folder to Clear",
    subtitle: "Free up disk space by removing local files that have already been safely uploaded. Each file is verified in the cloud before being removed.",
    details: "Before removing a local file, the app checks that the uploaded file exists on the cloud server, that its size matches, and compares checksums. A checksum is a unique fingerprint computed from the file's contents — if both fingerprints match, the files are identical.",
    actionableLabel: "uploaded (deletable)",
    actionableColor: "green" as const,
    actionableIcon: "check" as const,
    otherLabel: "not uploaded",
    otherColor: "gray" as const,
    otherIcon: "plus" as const,
    buttonLabel: (count: number) =>
      count > 0 ? `Clear ${count.toLocaleString()} file${count !== 1 ? "s" : ""}` : "Select Folder",
    buttonColor: "bg-red-600 text-white hover:bg-red-700",
    dimFolder: (_allUploaded: boolean, noneUploaded: boolean) => noneUploaded,
    dimFile: (uploaded: boolean) => !uploaded,
    uploadedBadge: { bg: "bg-green-50 text-green-700 border-green-200", label: "Uploaded" },
    notUploadedBadge: { bg: "bg-gray-100 text-gray-500 border-gray-200", label: "Not Uploaded" },
  },
} as const;

export default function FolderBrowser({
  onFolderSelected,
  initialPath,
  mode = "upload",
}: FolderBrowserProps) {
  const cfg = modeConfig[mode];
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [checkedFolders, setCheckedFolders] = useState<Set<string>>(new Set());
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [selectFirstN, setSelectFirstN] = useState("");
  const [fileSortKey, setFileSortKey] = useState<FileSortKey>("filename");
  const [fileSortDir, setFileSortDir] = useState<FileSortDir>("asc");

  const navigate = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = path ? { path } : {};
      const res = await apiGet<BrowseResponse>("/api/files/browse", params);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to browse folder");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    navigate(initialPath);
  }, [navigate, initialPath]);

  // Reset checked state and search when data changes (new directory loaded)
  useEffect(() => {
    if (!data) return;
    setCheckedFolders(new Set(data.folders.map((f) => f.name)));
    setCheckedFiles(new Set(data.files.map((f) => f.name)));
    setSearchQuery("");
    setSelectFirstN("");
  }, [data]);

  const breadcrumbItems = (data?.breadcrumbs ?? []).map((b, i, arr) => ({
    label: b.name,
    onClick: i < arr.length - 1 ? () => navigate(b.path) : undefined,
  }));

  const totalMcap = data?.total_mcap_count ?? 0;
  const alreadyUploaded = data?.already_uploaded ?? 0;
  const newFiles = totalMcap - alreadyUploaded;
  const hasFiles = totalMcap > 0;

  // Mode-dependent counts: "actionable" = files the user will act on
  const actionableCount = mode === "upload" ? newFiles : alreadyUploaded;
  const otherCount = mode === "upload" ? alreadyUploaded : newFiles;

  const totalItems = (data?.folders.length ?? 0) + (data?.files.length ?? 0);
  const checkedCount = checkedFolders.size + checkedFiles.size;
  const allChecked = totalItems > 0 && checkedCount === totalItems;

  const selectAll = useCallback(() => {
    if (!data) return;
    setCheckedFolders(new Set(data.folders.map((f) => f.name)));
    setCheckedFiles(new Set(data.files.map((f) => f.name)));
  }, [data]);

  const deselectAll = useCallback(() => {
    setCheckedFolders(new Set());
    setCheckedFiles(new Set());
  }, []);

  const toggleFolder = useCallback((name: string) => {
    setCheckedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleFile = useCallback((name: string) => {
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // Filtered folders/files based on search query
  const filteredFolders = useMemo(() => {
    if (!data || !searchQuery) return data?.folders ?? [];
    const q = searchQuery.toLowerCase();
    return data.folders.filter((f) => f.name.toLowerCase().includes(q));
  }, [data, searchQuery]);

  const filteredFiles = useMemo(() => {
    if (!data || !searchQuery) return data?.files ?? [];
    const q = searchQuery.toLowerCase();
    return data.files.filter((f) => f.name.toLowerCase().includes(q));
  }, [data, searchQuery]);

  // Sort the filtered files
  const sortedFiles = useMemo(() => {
    const sorted = [...filteredFiles];
    const dir = fileSortDir === "asc" ? 1 : -1;
    sorted.sort((a, b) => {
      switch (fileSortKey) {
        case "filename":
          return dir * a.name.localeCompare(b.name);
        case "size":
          return dir * (a.size - b.size);
        case "mtime":
          return dir * (a.mtime - b.mtime);
        case "status": {
          const sa = a.already_uploaded ? 1 : 0;
          const sb = b.already_uploaded ? 1 : 0;
          return dir * (sa - sb);
        }
        default:
          return 0;
      }
    });
    return sorted;
  }, [filteredFiles, fileSortKey, fileSortDir]);

  const handleFileSort = useCallback((key: FileSortKey) => {
    if (fileSortKey === key) {
      setFileSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setFileSortKey(key);
      setFileSortDir("asc");
    }
  }, [fileSortKey]);

  const isFiltering = searchQuery.length > 0;

  const selectShown = useCallback(() => {
    setCheckedFolders(new Set(filteredFolders.map((f) => f.name)));
    setCheckedFiles(new Set(filteredFiles.map((f) => f.name)));
  }, [filteredFolders, filteredFiles]);

  const applySelectFirstN = useCallback(() => {
    const n = Number.parseInt(selectFirstN, 10);
    if (Number.isNaN(n) || n <= 0) return;
    setCheckedFolders(new Set());
    setCheckedFiles(new Set(filteredFiles.slice(0, n).map((f) => f.name)));
    setSelectFirstN("");
  }, [selectFirstN, filteredFiles]);

  // Build exclusions from unchecked items
  const exclusions = useMemo((): FolderExclusions | undefined => {
    if (!data) return undefined;
    const uncheckedFolders = data.folders
      .filter((f) => !checkedFolders.has(f.name))
      .map((f) => f.name);
    const uncheckedFiles = data.files
      .filter((f) => !checkedFiles.has(f.name))
      .map((f) => f.name);
    if (uncheckedFolders.length === 0 && uncheckedFiles.length === 0) return undefined;
    return { subfolders: uncheckedFolders, files: uncheckedFiles };
  }, [data, checkedFolders, checkedFiles]);

  const handleUploadClick = useCallback(() => {
    if (!data) return;
    onFolderSelected(data.current_path, exclusions);
  }, [data, exclusions, onFolderSelected]);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      {/* Header */}
      <div className="border-b border-gray-200 px-5 py-3">
        <h3 className="text-lg font-semibold text-gray-900">
          {cfg.title}
        </h3>
        <p className="text-sm text-gray-500 mt-0.5">
          {cfg.subtitle}
        </p>
        {cfg.details && (
          <details className="mt-1.5">
            <summary className="text-xs text-nlr-blue cursor-pointer hover:underline select-none">
              How does verification work?
            </summary>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">
              {cfg.details}
            </p>
          </details>
        )}
      </div>

      <div className="flex min-h-[400px]">
        {/* Quick links sidebar */}
        <div className="w-48 border-r border-gray-200 bg-gray-50 p-3 flex-shrink-0">
          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Quick Links
          </h4>
          <ul className="space-y-1">
            {(data?.quick_links ?? []).map((link) => (
              <li key={link.path}>
                <button
                  type="button"
                  onClick={() => navigate(link.path)}
                  className="w-full text-left text-sm text-gray-700 hover:text-nlr-blue hover:bg-gray-100 rounded px-2 py-1.5 truncate"
                  title={link.path}
                >
                  <FolderIcon className="inline-block w-4 h-4 mr-1.5 text-gray-400" />
                  {link.name}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Main content area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Breadcrumbs */}
          <div className="px-4 py-2 border-b border-gray-100 bg-gray-50/50">
            <Breadcrumb items={breadcrumbItems} />
          </div>

          {/* Summary bar — always visible when we have data and MCAP files exist */}
          {!loading && data && hasFiles && (
            <div className="px-4 py-3 border-b border-gray-200 bg-white">
              <div className="flex items-center justify-between gap-4">
                {/* Stat chips */}
                <div className="flex items-center gap-3 flex-wrap">
                  <StatChip
                    icon={<FileIcon className="w-3.5 h-3.5" />}
                    value={totalMcap}
                    label={totalMcap === 1 ? "MCAP file" : "MCAP files"}
                    color="blue"
                  />
                  {actionableCount > 0 && (
                    <StatChip
                      icon={cfg.actionableIcon === "plus"
                        ? <PlusIcon className="w-3.5 h-3.5" />
                        : <CheckIcon className="w-3.5 h-3.5" />}
                      value={actionableCount}
                      label={cfg.actionableLabel}
                      color={cfg.actionableColor}
                    />
                  )}
                  {otherCount > 0 && (
                    <StatChip
                      icon={cfg.otherIcon === "check"
                        ? <CheckIcon className="w-3.5 h-3.5" />
                        : <PlusIcon className="w-3.5 h-3.5" />}
                      value={otherCount}
                      label={cfg.otherLabel}
                      color={cfg.otherColor}
                    />
                  )}
                  {totalMcap !== data.mcap_count && (
                    <span className="text-xs text-gray-400">
                      includes subfolders
                    </span>
                  )}
                </div>

                {/* Action button */}
                <button
                  type="button"
                  onClick={handleUploadClick}
                  disabled={checkedCount === 0}
                  className={`px-5 py-2 rounded text-sm font-medium transition-colors flex-shrink-0
                    ${cfg.buttonColor}
                    disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed`}
                >
                  {cfg.buttonLabel(actionableCount)}
                  <ChevronRightIcon className="w-4 h-4 ml-1 inline-block" />
                </button>
              </div>
            </div>
          )}

          {/* Loading / Error */}
          {loading && (
            <div className="flex-1 flex items-center justify-center">
              <Spinner message="Loading..." />
            </div>
          )}

          {error && (
            <div className="p-4 text-sm text-red-600 bg-red-50 m-4 rounded">
              {error}
            </div>
          )}

          {/* Folder and file list */}
          {!loading && !error && data && (
            <div className="flex-1 overflow-auto">
              {/* Selection toolbar */}
              {totalItems > 0 && (
                <div className="space-y-1 px-4 py-1.5 border-b border-gray-100 bg-gray-50/50 text-xs">
                  <div className="flex items-center gap-3">
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search files and folders..."
                      className="border border-gray-300 rounded px-2 py-1 text-xs bg-white w-52"
                    />
                    <div className="flex items-center gap-1.5 ml-auto">
                      <span className="text-gray-400">Select:</span>
                      <button
                        type="button"
                        onClick={selectAll}
                        disabled={allChecked}
                        className="text-nlr-blue hover:underline disabled:text-gray-400 disabled:no-underline"
                      >
                        All
                      </button>
                      {isFiltering && (
                        <>
                          <span className="text-gray-300">|</span>
                          <button
                            type="button"
                            onClick={selectShown}
                            className="text-nlr-blue hover:underline"
                          >
                            Shown
                          </button>
                        </>
                      )}
                      <span className="text-gray-300">|</span>
                      <button
                        type="button"
                        onClick={deselectAll}
                        disabled={checkedCount === 0}
                        className="text-nlr-blue hover:underline disabled:text-gray-400 disabled:no-underline"
                      >
                        None
                      </button>
                    </div>
                  </div>
                  {data.files.length > 0 && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-gray-400">Select first</span>
                      <input
                        type="number"
                        min="1"
                        value={selectFirstN}
                        onChange={(e) => setSelectFirstN(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") applySelectFirstN(); }}
                        placeholder="#"
                        className="border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white w-16 tabular-nums"
                      />
                      <button
                        type="button"
                        onClick={applySelectFirstN}
                        disabled={!selectFirstN || Number.parseInt(selectFirstN, 10) <= 0}
                        className="text-nlr-blue hover:underline disabled:text-gray-300 disabled:no-underline"
                      >
                        files
                      </button>
                      <span className="ml-auto text-gray-400">
                        {checkedCount} of {totalItems} selected
                        {isFiltering && ` (${filteredFolders.length + filteredFiles.length} shown)`}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Folders */}
              {filteredFolders.length > 0 && (
                <FolderList
                  folders={filteredFolders}
                  onNavigate={navigate}
                  checkedFolders={checkedFolders}
                  onToggleFolder={toggleFolder}
                  mode={mode}
                />
              )}

              {/* Files */}
              {sortedFiles.length > 0 && (
                <FileList
                  files={sortedFiles}
                  checkedFiles={checkedFiles}
                  onToggleFile={toggleFile}
                  sortKey={fileSortKey}
                  sortDir={fileSortDir}
                  onSort={handleFileSort}
                  mode={mode}
                />
              )}

              {/* Empty state */}
              {filteredFolders.length === 0 && filteredFiles.length === 0 && (
                <div className="flex-1 flex items-center justify-center p-8 text-gray-400 text-sm">
                  {isFiltering
                    ? "No items match your search."
                    : "No folders or MCAP files found here."}
                </div>
              )}
            </div>
          )}

          {/* Minimal footer showing path */}
          {!loading && data && (
            <div className="border-t border-gray-200 px-4 py-2 bg-gray-50">
              <span className="text-xs text-gray-400 truncate block" title={data.current_path}>
                {data.current_path}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Sub-components ─── */

/** Compact stat chip for the summary bar. */
function StatChip({
  icon,
  value,
  label,
  color,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
  color: "blue" | "green" | "gray";
}) {
  const colors = {
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    green: "bg-green-50 text-green-700 border-green-200",
    gray: "bg-gray-100 text-gray-600 border-gray-200",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${colors[color]}`}>
      {icon}
      <span className="tabular-nums font-semibold">{value.toLocaleString()}</span>
      {label}
    </span>
  );
}


function FolderList({
  folders,
  onNavigate,
  checkedFolders,
  onToggleFolder,
  mode = "upload",
}: {
  folders: LocalFolder[];
  onNavigate: (path: string) => void;
  checkedFolders: Set<string>;
  onToggleFolder: (name: string) => void;
  mode?: BrowserMode;
}) {
  const cfg = modeConfig[mode];
  return (
    <div className="divide-y divide-gray-100">
      {folders.map((folder) => {
        const allUploaded = folder.mcap_count > 0 && folder.already_uploaded === folder.mcap_count;
        const someUploaded = folder.already_uploaded > 0 && !allUploaded;
        const noneUploaded = folder.mcap_count > 0 && folder.already_uploaded === 0;
        const isDimmed = cfg.dimFolder(allUploaded, noneUploaded);

        return (
          <div
            key={folder.path}
            className={`flex items-center px-4 py-2.5 hover:bg-gray-50 group ${isDimmed ? "opacity-60" : ""}`}
          >
            <input
              type="checkbox"
              checked={checkedFolders.has(folder.name)}
              onChange={() => onToggleFolder(folder.name)}
              className="h-3.5 w-3.5 rounded border-gray-300 text-nlr-blue focus:ring-nlr-blue cursor-pointer flex-shrink-0 mr-2"
            />
            <button
              type="button"
              onClick={() => onNavigate(folder.path)}
              className="flex items-center flex-1 min-w-0 text-left"
            >
              <FolderIcon className="w-5 h-5 text-amber-400 flex-shrink-0 mr-3" />
              <span className="text-sm text-gray-800 group-hover:text-nlr-blue truncate flex-1">
                {folder.name}
              </span>
            </button>
            {folder.mcap_count > 0 && (
              <span className="ml-2 flex items-center gap-2 flex-shrink-0">
                {/* Upload status indicator */}
                {allUploaded && (
                  <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                    <CheckIcon className="w-3.5 h-3.5 text-green-500" />
                    {folder.mcap_count}/{folder.mcap_count} uploaded
                  </span>
                )}
                {someUploaded && (
                  <span className="inline-flex items-center gap-1.5 text-xs">
                    <UploadProgress uploaded={folder.already_uploaded} total={folder.mcap_count} />
                    <span className="text-gray-600">
                      {folder.already_uploaded}/{folder.mcap_count} uploaded
                    </span>
                  </span>
                )}
                {noneUploaded && (
                  <span className="text-xs text-blue-600 font-medium">
                    {folder.mcap_count} file{folder.mcap_count !== 1 ? "s" : ""}
                  </span>
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Simple progress bar showing upload fraction. */
function UploadProgress({ uploaded, total }: { uploaded: number; total: number }) {
  const pct = total > 0 ? (uploaded / total) * 100 : 0;

  return (
    <div className="w-12 h-1.5 bg-gray-200 rounded-full overflow-hidden">
      <div
        className="h-full bg-amber-500 rounded-full transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function FileList({
  files,
  checkedFiles,
  onToggleFile,
  sortKey,
  sortDir,
  onSort,
  mode = "upload",
}: {
  files: LocalFile[];
  checkedFiles: Set<string>;
  onToggleFile: (name: string) => void;
  sortKey: FileSortKey;
  sortDir: FileSortDir;
  onSort: (key: FileSortKey) => void;
  mode?: BrowserMode;
}) {
  const cfg = modeConfig[mode];
  return (
    <div>
      {/* Column headers */}
      <div className="grid grid-cols-[28px_1fr_80px_100px_120px] gap-2 px-4 py-2 bg-gray-50 border-y border-gray-200 text-xs font-medium text-gray-500 uppercase tracking-wider">
        <div />
        <FileSortHeader label="Filename" sortKey="filename" currentKey={sortKey} dir={sortDir} onSort={onSort} />
        <FileSortHeader label="Size" sortKey="size" currentKey={sortKey} dir={sortDir} onSort={onSort} className="justify-end" />
        <FileSortHeader label="Modified" sortKey="mtime" currentKey={sortKey} dir={sortDir} onSort={onSort} />
        <FileSortHeader label="Status" sortKey="status" currentKey={sortKey} dir={sortDir} onSort={onSort} className="justify-center" />
      </div>
      {/* File rows */}
      <div className="divide-y divide-gray-100">
        {files.map((file) => {
          const uploaded = file.already_uploaded === true;
          const isDimmed = cfg.dimFile(uploaded);
          const badge = uploaded ? cfg.uploadedBadge : cfg.notUploadedBadge;
          return (
            <div
              key={file.path}
              className={`grid grid-cols-[28px_1fr_80px_100px_120px] gap-2 px-4 py-2 items-center text-sm hover:bg-gray-50/50 ${isDimmed ? "bg-gray-50/30" : ""}`}
            >
              <input
                type="checkbox"
                checked={checkedFiles.has(file.name)}
                onChange={() => onToggleFile(file.name)}
                className="h-3.5 w-3.5 rounded border-gray-300 text-nlr-blue focus:ring-nlr-blue cursor-pointer"
              />
              <span className={`truncate ${isDimmed ? "text-gray-400" : "text-gray-800"}`}>
                {file.name}
              </span>
              <span className="text-gray-400 text-xs text-right tabular-nums">
                {formatBytes(file.size)}
              </span>
              <span className="text-gray-400 text-xs">
                {formatDate(file.mtime)}
              </span>
              <span className="flex justify-center">
                {uploaded ? (
                  <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${badge.bg}`}>
                    <CheckIcon className="w-3 h-3" />
                    {badge.label}
                  </span>
                ) : (
                  <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${badge.bg}`}>
                    <UploadIcon className="w-3 h-3" />
                    {badge.label}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FileSortHeader({
  label,
  sortKey,
  currentKey,
  dir,
  onSort,
  className = "",
}: {
  label: string;
  sortKey: FileSortKey;
  currentKey: FileSortKey;
  dir: FileSortDir;
  onSort: (key: FileSortKey) => void;
  className?: string;
}) {
  const active = sortKey === currentKey;
  const arrow = active ? (dir === "asc" ? " \u2191" : " \u2193") : "";
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`flex items-center gap-1 hover:text-gray-700 cursor-pointer select-none ${active ? "text-gray-700" : ""} ${className}`}
    >
      {label}
      {arrow && <span className="text-nlr-blue">{arrow}</span>}
    </button>
  );
}
