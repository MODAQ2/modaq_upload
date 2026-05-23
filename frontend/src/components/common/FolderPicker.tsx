/**
 * Lightweight folder picker for the Large Folder Upload page.
 *
 * Navigates the local filesystem (via /api/files/browse) and lets the user
 * select the current directory with a single button click. Unlike FolderBrowser
 * it does not show individual file upload status — it's purely a directory chooser.
 */

import { useCallback, useEffect, useState } from 'react';

import { apiGet } from '../../api/client.ts';
import type { BrowseResponse } from '../../types/api.ts';
import { formatBytes } from '../../utils/format/bytes.ts';
import { ChevronRightIcon, FolderIcon, RefreshIcon } from '../../utils/icons.tsx';
import Breadcrumb from '../common/Breadcrumb.tsx';
import Spinner from '../common/Spinner.tsx';

interface FolderPickerProps {
  onFolderSelected: (folderPath: string) => void;
  initialPath?: string;
}

export default function FolderPicker({ onFolderSelected, initialPath }: FolderPickerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BrowseResponse | null>(null);

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

  const breadcrumbItems = (data?.breadcrumbs ?? []).map((b, i, arr) => ({
    label: b.name,
    onClick: i < arr.length - 1 ? () => navigate(b.path) : undefined,
  }));

  const handleSelect = useCallback(() => {
    if (data) onFolderSelected(data.current_path);
  }, [data, onFolderSelected]);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      {/* Header */}
      <div className="border-b border-gray-200 px-5 py-3">
        <h3 className="text-lg font-semibold text-gray-900">Select Folder to Sync</h3>
        <p className="text-sm text-gray-500 mt-0.5">
          Navigate to the folder you want to sync, then click <strong>Select This Folder</strong>.
        </p>
      </div>

      <div className="flex min-h-[360px]">
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

        {/* Main content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Breadcrumbs + refresh */}
          <div className="px-4 py-2 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
            <Breadcrumb items={breadcrumbItems} />
            <button
              type="button"
              onClick={() => data && navigate(data.current_path)}
              disabled={loading}
              title="Refresh folder"
              className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-200 transition-colors disabled:opacity-50"
            >
              <RefreshIcon className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* "Select this folder" bar */}
          {!loading && data && (
            <div className="px-4 py-3 border-b border-gray-200 bg-white flex items-center justify-between gap-4">
              <div className="text-sm text-gray-700 min-w-0">
                <span className="font-mono text-xs text-gray-500 truncate block">
                  {data.current_path}
                </span>
                {data.total_file_count > 0 && (
                  <span className="text-xs text-gray-400">
                    {data.total_file_count.toLocaleString()} file
                    {data.total_file_count !== 1 ? 's' : ''} total
                    {data.total_file_count > data.file_count ? ' (includes subfolders)' : ''}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={handleSelect}
                className="flex items-center gap-1.5 px-4 py-2 rounded text-sm font-medium bg-nlr-blue text-white hover:bg-blue-700 transition-colors flex-shrink-0"
              >
                <FolderIcon className="w-4 h-4" />
                Select This Folder
                <ChevronRightIcon className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Loading / Error */}
          {loading && (
            <div className="flex-1 flex items-center justify-center">
              <Spinner message="Loading..." />
            </div>
          )}
          {error && <div className="p-4 text-sm text-red-600 bg-red-50 m-4 rounded">{error}</div>}

          {/* Subfolders */}
          {!loading && !error && data && (
            <div className="flex-1 overflow-y-auto">
              {data.folders.length === 0 && (
                <p className="text-sm text-gray-400 px-4 py-6 text-center">
                  No subfolders — this is a leaf directory.
                </p>
              )}
              {data.folders.map((folder) => (
                <button
                  key={folder.path}
                  type="button"
                  onClick={() => navigate(folder.path)}
                  className="w-full text-left flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 border-b border-gray-100 last:border-0 group"
                >
                  <FolderIcon className="w-5 h-5 text-amber-400 flex-shrink-0" />
                  <span className="flex-1 text-sm font-medium text-gray-800 truncate">
                    {folder.name}
                  </span>
                  {folder.file_count > 0 && (
                    <span className="text-xs text-gray-400 flex-shrink-0">
                      {folder.file_count.toLocaleString()} file
                      {folder.file_count !== 1 ? 's' : ''}
                    </span>
                  )}
                  <ChevronRightIcon className="w-4 h-4 text-gray-300 group-hover:text-gray-500 flex-shrink-0" />
                </button>
              ))}

              {/* Show file count summary if there are direct files */}
              {data.files.length > 0 && (
                <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 text-xs text-gray-500">
                  {data.files.length.toLocaleString()} direct file
                  {data.files.length !== 1 ? 's' : ''} in this folder
                  {' · '}
                  {formatBytes(data.files.reduce((sum, f) => sum + f.size, 0))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
