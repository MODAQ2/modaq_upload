/**
 * Step 1: Filesystem browser for selecting a folder of Data Files.
 *
 * Fetches `GET /api/files/browse?path=...` and renders:
 * - Quick links sidebar
 * - Breadcrumb navigation
 * - Summary bar with file counts + upload button (top, always visible)
 * - Folder list with upload progress indicators (virtualized)
 * - Data file list with clear uploaded/new status (virtualized)
 *
 * Selection is stored as a discriminated union ("all-except" | "subset") so
 * loading a directory with thousands of items never materializes an N-sized Set.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiGet } from '../../api/client.ts';
import type { BrowseResponse, LocalFile, LocalFolder } from '../../types/api.ts';
import { formatBytes } from '../../utils/format/bytes.ts';
import { formatDate } from '../../utils/format/date.ts';
import {
  CheckIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  RefreshIcon,
  UploadIcon,
} from '../../utils/icons.tsx';
import Breadcrumb from '../common/Breadcrumb.tsx';
import Spinner from '../common/Spinner.tsx';
import {
  isChecked,
  SELECTION_ALL,
  SELECTION_NONE,
  type Selection,
  selectionSize,
  toggleSelection,
  uncheckedNames,
} from './folderBrowserSelection.ts';

type FileSortKey = 'filename' | 'size' | 'mtime' | 'status';
type FileSortDir = 'asc' | 'desc';

export type BrowserMode = 'upload' | 'delete';

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
    title: 'Select Folder to Upload',
    subtitle: 'Browse to a folder containing files.',
    details: '',
    /** Stat chip shown for the "actionable" count (new files for upload). */
    actionableLabel: 'not uploaded',
    actionableColor: 'green' as const,
    actionableIcon: 'plus' as const,
    /** Stat chip shown for the "other" count (already uploaded). */
    otherLabel: 'already uploaded',
    otherColor: 'gray' as const,
    otherIcon: 'check' as const,
    /** Action button wording — count is the "actionable" file count. */
    buttonLabel: (count: number) =>
      count > 0
        ? `Upload ${count.toLocaleString()} file${count !== 1 ? 's' : ''}`
        : 'Upload This Folder',
    buttonColor: 'bg-nlr-blue text-white hover:bg-blue-700',
    /** For folders: dim when ALL files are already uploaded (nothing to upload). */
    dimFolder: (allUploaded: boolean, _noneUploaded: boolean) => allUploaded,
    /** For file rows: dim files that are already uploaded. */
    dimFile: (uploaded: boolean) => uploaded,
    /** Status badge for "uploaded" files. */
    uploadedBadge: { bg: 'bg-green-50 text-green-700 border-green-200', label: 'Uploaded' },
    /** Status badge for "not uploaded" files. */
    notUploadedBadge: { bg: 'bg-amber-50 text-amber-700 border-amber-200', label: 'Not Uploaded' },
  },
  delete: {
    title: 'Select Folder to Clear',
    subtitle:
      'Free up disk space by removing local files that have already been safely uploaded. Each file is verified in the cloud before being removed.',
    details:
      "Before removing a local file, the app checks that the uploaded file exists on the cloud server, that its size matches, and compares checksums. A checksum is a unique fingerprint computed from the file's contents — if both fingerprints match, the files are identical.",
    actionableLabel: 'uploaded (deletable)',
    actionableColor: 'green' as const,
    actionableIcon: 'check' as const,
    otherLabel: 'not uploaded',
    otherColor: 'gray' as const,
    otherIcon: 'plus' as const,
    buttonLabel: (count: number) =>
      count > 0 ? `Clear ${count.toLocaleString()} file${count !== 1 ? 's' : ''}` : 'Select Folder',
    buttonColor: 'bg-red-600 text-white hover:bg-red-700',
    dimFolder: (_allUploaded: boolean, noneUploaded: boolean) => noneUploaded,
    dimFile: (uploaded: boolean) => !uploaded,
    uploadedBadge: { bg: 'bg-green-50 text-green-700 border-green-200', label: 'Uploaded' },
    notUploadedBadge: { bg: 'bg-gray-100 text-gray-500 border-gray-200', label: 'Not Uploaded' },
  },
} as const;

export default function FolderBrowser({
  onFolderSelected,
  initialPath,
  mode = 'upload',
}: FolderBrowserProps) {
  const cfg = modeConfig[mode];
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [folderSelection, setFolderSelection] = useState<Selection>(SELECTION_ALL);
  const [fileSelection, setFileSelection] = useState<Selection>(SELECTION_ALL);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectFirstN, setSelectFirstN] = useState('');
  const [fileSortKey, setFileSortKey] = useState<FileSortKey>('filename');
  const [fileSortDir, setFileSortDir] = useState<FileSortDir>('asc');

  const navigate = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = path ? { path } : {};
      const res = await apiGet<BrowseResponse>('/api/files/browse', params);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse folder');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    navigate(initialPath);
  }, [navigate, initialPath]);

  /** Re-fetch the current directory without resetting to initialPath. */
  const refresh = useCallback(() => {
    if (data) {
      navigate(data.current_path);
    } else {
      navigate(initialPath);
    }
  }, [data, navigate, initialPath]);

  // Reset selection / search when data changes (new directory loaded).
  // "all-except" with empty excluded = everything checked, O(1) — no Set of 10k names.
  useEffect(() => {
    if (!data) return;
    setFolderSelection(SELECTION_ALL);
    setFileSelection(SELECTION_ALL);
    setSearchQuery('');
    setSelectFirstN('');
  }, [data]);

  const breadcrumbItems = (data?.breadcrumbs ?? []).map((b, i, arr) => ({
    label: b.name,
    onClick: i < arr.length - 1 ? () => navigate(b.path) : undefined,
  }));

  const totalFiles = data?.total_file_count ?? 0;
  const alreadyUploaded = data?.already_uploaded ?? 0;
  const newFiles = totalFiles - alreadyUploaded;
  const hasFiles = totalFiles > 0;
  const totalCategoryCounts = data?.total_category_counts ?? {};
  // Categories with at least one file in the current tree, in stable order.
  const visibleCategories = Object.entries(totalCategoryCounts)
    .filter(([, n]) => n > 0)
    .map(([name]) => name);

  // Mode-dependent counts: "actionable" = files the user will act on
  const actionableCount = mode === 'upload' ? newFiles : alreadyUploaded;
  const otherCount = mode === 'upload' ? alreadyUploaded : newFiles;

  const totalFolders = data?.folders.length ?? 0;
  const totalLooseFiles = data?.files.length ?? 0;
  const totalItems = totalFolders + totalLooseFiles;
  const checkedCount =
    selectionSize(folderSelection, totalFolders) + selectionSize(fileSelection, totalLooseFiles);
  const allChecked = totalItems > 0 && checkedCount === totalItems;

  // Count actionable files among the user's current selection.
  // In all-except mode this iterates the small "excluded" set; in subset mode it iterates the
  // small "included" set. Never iterates the full 10k-item list.
  const selectedActionableCount = useMemo(() => {
    if (!data) return 0;
    let count = 0;
    for (const folder of data.folders) {
      if (!isChecked(folderSelection, folder.name)) continue;
      count +=
        mode === 'upload' ? folder.file_count - folder.already_uploaded : folder.already_uploaded;
    }
    for (const file of data.files) {
      if (!isChecked(fileSelection, file.name)) continue;
      const uploaded = file.already_uploaded ?? false;
      if (mode === 'upload' ? !uploaded : uploaded) count += 1;
    }
    return count;
  }, [data, folderSelection, fileSelection, mode]);

  const selectAll = useCallback(() => {
    setFolderSelection(SELECTION_ALL);
    setFileSelection(SELECTION_ALL);
  }, []);

  const deselectAll = useCallback(() => {
    setFolderSelection(SELECTION_NONE);
    setFileSelection(SELECTION_NONE);
  }, []);

  const toggleFolder = useCallback((name: string) => {
    setFolderSelection((prev) => toggleSelection(prev, name));
  }, []);

  const toggleFile = useCallback((name: string) => {
    setFileSelection((prev) => toggleSelection(prev, name));
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
    const dir = fileSortDir === 'asc' ? 1 : -1;
    sorted.sort((a, b) => {
      switch (fileSortKey) {
        case 'filename':
          return dir * a.name.localeCompare(b.name);
        case 'size':
          return dir * (a.size - b.size);
        case 'mtime':
          return dir * (a.mtime - b.mtime);
        case 'status': {
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

  const handleFileSort = useCallback(
    (key: FileSortKey) => {
      if (fileSortKey === key) {
        setFileSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setFileSortKey(key);
        setFileSortDir('asc');
      }
    },
    [fileSortKey],
  );

  const isFiltering = searchQuery.length > 0;

  const selectShown = useCallback(() => {
    setFolderSelection({ mode: 'subset', included: new Set(filteredFolders.map((f) => f.name)) });
    setFileSelection({ mode: 'subset', included: new Set(filteredFiles.map((f) => f.name)) });
  }, [filteredFolders, filteredFiles]);

  const applySelectFirstN = useCallback(() => {
    const n = Number.parseInt(selectFirstN, 10);
    if (Number.isNaN(n) || n <= 0) return;
    setFolderSelection(SELECTION_NONE);
    setFileSelection({
      mode: 'subset',
      included: new Set(filteredFiles.slice(0, n).map((f) => f.name)),
    });
    setSelectFirstN('');
  }, [selectFirstN, filteredFiles]);

  // Build exclusions list for the parent (only names that are NOT checked).
  // In the common "everything checked" case this is empty and exits fast.
  const exclusions = useMemo((): FolderExclusions | undefined => {
    if (!data) return undefined;
    const allFolderNames = data.folders.map((f) => f.name);
    const allFileNames = data.files.map((f) => f.name);
    const uncheckedFolders = uncheckedNames(folderSelection, allFolderNames);
    const uncheckedFiles = uncheckedNames(fileSelection, allFileNames);
    if (uncheckedFolders.length === 0 && uncheckedFiles.length === 0) return undefined;
    return { subfolders: uncheckedFolders, files: uncheckedFiles };
  }, [data, folderSelection, fileSelection]);

  const handleUploadClick = useCallback(() => {
    if (!data) return;
    onFolderSelected(data.current_path, exclusions);
  }, [data, exclusions, onFolderSelected]);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      {/* Header */}
      <div className="border-b border-gray-200 px-5 py-3">
        <h3 className="text-lg font-semibold text-gray-900">{cfg.title}</h3>
        <p className="text-sm text-gray-500 mt-0.5">{cfg.subtitle}</p>
        {cfg.details && (
          <details className="mt-1.5">
            <summary className="text-xs text-nlr-blue cursor-pointer hover:underline select-none">
              How does verification work?
            </summary>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">{cfg.details}</p>
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
          {/* Breadcrumbs + refresh */}
          <div className="px-4 py-2 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
            <Breadcrumb items={breadcrumbItems} />
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              title="Refresh folder"
              className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-200 transition-colors disabled:opacity-50"
            >
              <RefreshIcon className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Summary bar — always visible when we have data and any files exist */}
          {!loading && data && hasFiles && (
            <div className="px-4 py-3 border-b border-gray-200 bg-white">
              <div className="flex items-center justify-between gap-4">
                {/* Stat chips */}
                <div className="flex items-center gap-3 flex-wrap">
                  <StatChip
                    icon={<FileIcon className="w-3.5 h-3.5" />}
                    value={totalFiles}
                    label={totalFiles === 1 ? 'File' : 'Files'}
                    color="blue"
                  />
                  {visibleCategories.length > 1 &&
                    visibleCategories.map((cat) => (
                      <StatChip
                        key={cat}
                        icon={<FileIcon className="w-3.5 h-3.5" />}
                        value={totalCategoryCounts[cat] ?? 0}
                        label={formatCategoryLabel(cat)}
                        color="gray"
                      />
                    ))}
                  {actionableCount > 0 && (
                    <StatChip
                      icon={
                        cfg.actionableIcon === 'plus' ? (
                          <PlusIcon className="w-3.5 h-3.5" />
                        ) : (
                          <CheckIcon className="w-3.5 h-3.5" />
                        )
                      }
                      value={actionableCount}
                      label={cfg.actionableLabel}
                      color={cfg.actionableColor}
                    />
                  )}
                  {otherCount > 0 && (
                    <StatChip
                      icon={
                        cfg.otherIcon === 'check' ? (
                          <CheckIcon className="w-3.5 h-3.5" />
                        ) : (
                          <PlusIcon className="w-3.5 h-3.5" />
                        )
                      }
                      value={otherCount}
                      label={cfg.otherLabel}
                      color={cfg.otherColor}
                    />
                  )}
                  {totalFiles !== data.file_count && (
                    <span className="text-xs text-gray-400">includes subfolders</span>
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
                  {cfg.buttonLabel(selectedActionableCount)}
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

          {error && <div className="p-4 text-sm text-red-600 bg-red-50 m-4 rounded">{error}</div>}

          {/* Folder and file list */}
          {!loading && !error && data && (
            <div className="flex-1 flex flex-col min-h-0">
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
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') applySelectFirstN();
                        }}
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

              {/* Folders (virtualized) */}
              {filteredFolders.length > 0 && (
                <FolderList
                  folders={filteredFolders}
                  onNavigate={navigate}
                  selection={folderSelection}
                  onToggleFolder={toggleFolder}
                  mode={mode}
                />
              )}

              {/* Files (virtualized) */}
              {sortedFiles.length > 0 && (
                <FileList
                  files={sortedFiles}
                  selection={fileSelection}
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
                    ? 'No items match your search.'
                    : 'No folders or matching files found here.'}
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

/** Render a category name in a friendly form: "data" → "Data", "logs" → "Logs". */
function formatCategoryLabel(name: string): string {
  if (!name) return '';
  return name.charAt(0).toUpperCase() + name.slice(1);
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
  color: 'blue' | 'green' | 'gray';
}) {
  const colors = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    gray: 'bg-gray-100 text-gray-600 border-gray-200',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${colors[color]}`}
    >
      {icon}
      <span className="tabular-nums font-semibold">{value.toLocaleString()}</span>
      {label}
    </span>
  );
}

// Virtualized list constants
const FOLDER_ROW_HEIGHT = 44;
const FILE_ROW_HEIGHT = 36;
const LIST_MAX_HEIGHT = 520;
const FOLDER_LIST_MAX_HEIGHT = 280;

function FolderList({
  folders,
  onNavigate,
  selection,
  onToggleFolder,
  mode = 'upload',
}: {
  folders: LocalFolder[];
  onNavigate: (path: string) => void;
  selection: Selection;
  onToggleFolder: (name: string) => void;
  mode?: BrowserMode;
}) {
  const cfg = modeConfig[mode];
  const scrollRef = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: folders.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FOLDER_ROW_HEIGHT,
    overscan: 10,
  });

  const height = Math.min(folders.length * FOLDER_ROW_HEIGHT, FOLDER_LIST_MAX_HEIGHT);

  return (
    <div
      ref={scrollRef}
      className="overflow-auto border-b border-gray-200 flex-shrink-0"
      style={{ height }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          // biome-ignore lint/style/noNonNullAssertion: virtualizer index is always within bounds
          const folder = folders[virtualRow.index]!;
          const allUploaded =
            folder.file_count > 0 && folder.already_uploaded === folder.file_count;
          const someUploaded = folder.already_uploaded > 0 && !allUploaded;
          const noneUploaded = folder.file_count > 0 && folder.already_uploaded === 0;
          const isDimmed = cfg.dimFolder(allUploaded, noneUploaded);
          const checked = isChecked(selection, folder.name);
          const folderCategoryCounts = folder.category_counts ?? {};
          const folderCategoryEntries = Object.entries(folderCategoryCounts).filter(
            ([, n]) => n > 0,
          );
          const showCategoryBreakdown = folderCategoryEntries.length > 1;

          return (
            <div
              key={folder.path}
              className={`flex items-center px-4 py-2.5 hover:bg-gray-50 group border-b border-gray-100 ${isDimmed ? 'opacity-60' : ''}`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <input
                type="checkbox"
                checked={checked}
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
              {folder.file_count > 0 && (
                <span className="ml-2 flex items-center gap-2 flex-shrink-0">
                  {showCategoryBreakdown && (
                    <span className="hidden xl:inline-flex items-center gap-1 text-[10px] text-gray-500">
                      {folderCategoryEntries.map(([cat, n], i) => (
                        <span key={cat}>
                          {i > 0 && <span className="text-gray-300 mx-1">·</span>}
                          <span className="font-semibold tabular-nums">{n}</span>{' '}
                          {formatCategoryLabel(cat).toLowerCase()}
                        </span>
                      ))}
                    </span>
                  )}
                  {allUploaded && (
                    <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                      <CheckIcon className="w-3.5 h-3.5 text-green-700" />
                      {folder.file_count}/{folder.file_count} uploaded
                    </span>
                  )}
                  {someUploaded && (
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <UploadProgress
                        uploaded={folder.already_uploaded}
                        total={folder.file_count}
                      />
                      <span className="text-gray-600">
                        {folder.already_uploaded}/{folder.file_count} uploaded
                      </span>
                    </span>
                  )}
                  {noneUploaded && (
                    <span className="text-xs text-blue-600 font-medium">
                      {folder.file_count} file{folder.file_count !== 1 ? 's' : ''}
                    </span>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
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
  selection,
  onToggleFile,
  sortKey,
  sortDir,
  onSort,
  mode = 'upload',
}: {
  files: LocalFile[];
  selection: Selection;
  onToggleFile: (name: string) => void;
  sortKey: FileSortKey;
  sortDir: FileSortDir;
  onSort: (key: FileSortKey) => void;
  mode?: BrowserMode;
}) {
  const cfg = modeConfig[mode];
  const scrollRef = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_ROW_HEIGHT,
    overscan: 20,
  });

  const height = Math.min(files.length * FILE_ROW_HEIGHT, LIST_MAX_HEIGHT);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Column headers (sticky above the virtualized scroll region) */}
      <div className="grid grid-cols-[28px_1fr_80px_100px_120px] gap-2 px-4 py-2 bg-gray-50 border-y border-gray-200 text-xs font-medium text-gray-500 uppercase tracking-wider flex-shrink-0">
        <div />
        <FileSortHeader
          label="Filename"
          sortKey="filename"
          currentKey={sortKey}
          dir={sortDir}
          onSort={onSort}
        />
        <FileSortHeader
          label="Size"
          sortKey="size"
          currentKey={sortKey}
          dir={sortDir}
          onSort={onSort}
          className="justify-end"
        />
        <FileSortHeader
          label="Modified"
          sortKey="mtime"
          currentKey={sortKey}
          dir={sortDir}
          onSort={onSort}
        />
        <FileSortHeader
          label="Status"
          sortKey="status"
          currentKey={sortKey}
          dir={sortDir}
          onSort={onSort}
          className="justify-center"
        />
      </div>
      {/* Virtualized file rows */}
      <div ref={scrollRef} className="overflow-auto" style={{ height }}>
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            // biome-ignore lint/style/noNonNullAssertion: virtualizer index is always within bounds
            const file = files[virtualRow.index]!;
            const uploaded = file.already_uploaded === true;
            const isDimmed = cfg.dimFile(uploaded);
            const badge = uploaded ? cfg.uploadedBadge : cfg.notUploadedBadge;
            const checked = isChecked(selection, file.name);
            return (
              <div
                key={file.path}
                className={`grid grid-cols-[28px_1fr_80px_100px_120px] gap-2 px-4 items-center text-sm hover:bg-gray-50/50 border-b border-gray-100 ${isDimmed ? 'bg-gray-50/30' : ''}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleFile(file.name)}
                  className="h-3.5 w-3.5 rounded border-gray-300 text-nlr-blue focus:ring-nlr-blue cursor-pointer"
                />
                <span className={`truncate ${isDimmed ? 'text-gray-400' : 'text-gray-800'}`}>
                  {file.name}
                </span>
                <span className="text-gray-400 text-xs text-right tabular-nums">
                  {formatBytes(file.size)}
                </span>
                <span className="text-gray-400 text-xs">{formatDate(file.mtime)}</span>
                <span className="flex justify-center">
                  {uploaded ? (
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${badge.bg}`}
                    >
                      <CheckIcon className="w-3 h-3" />
                      {badge.label}
                    </span>
                  ) : (
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${badge.bg}`}
                    >
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
    </div>
  );
}

function FileSortHeader({
  label,
  sortKey,
  currentKey,
  dir,
  onSort,
  className = '',
}: {
  label: string;
  sortKey: FileSortKey;
  currentKey: FileSortKey;
  dir: FileSortDir;
  onSort: (key: FileSortKey) => void;
  className?: string;
}) {
  const active = sortKey === currentKey;
  const arrow = active ? (dir === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`flex items-center gap-1 hover:text-gray-700 cursor-pointer select-none ${active ? 'text-gray-700' : ''} ${className}`}
    >
      {label}
      {arrow && <span className="text-nlr-blue">{arrow}</span>}
    </button>
  );
}
