/**
 * S3FolderPicker — browse the configured S3 bucket and choose a destination folder.
 *
 * Renders inline (not a modal). At any level the user can either:
 *   - sync into the folder they've navigated into, or
 *   - create a new subfolder at the current location.
 *
 * Calls `onSelect(prefix)` with the resolved key prefix (no leading slash, no
 * trailing slash) whenever a valid destination is chosen. The bucket root is not
 * a valid "folder" destination.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { apiGet } from '../../api/client.ts';
import type { S3ListResponse } from '../../types/api.ts';
import { CloudIcon, FolderIcon, RefreshIcon } from '../../utils/icons.tsx';
import Breadcrumb from './Breadcrumb.tsx';
import Spinner from './Spinner.tsx';
import { type DestMode, resolveDestination } from './s3FolderPath.ts';

interface S3FolderPickerProps {
  bucket: string;
  /** Called with the resolved prefix (no surrounding slashes) when a destination is chosen. */
  onSelect: (prefix: string) => void;
  /**
   * Optional suggested top-level folder name. When provided, a shortcut button
   * sets the destination to a new folder of this name at the bucket root.
   */
  suggestedName?: string;
}

export default function S3FolderPicker({ bucket, onSelect, suggestedName }: S3FolderPickerProps) {
  const [prefix, setPrefix] = useState('');
  const [folders, setFolders] = useState<{ name: string; prefix: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<DestMode>('new');
  const [newName, setNewName] = useState('');

  const fetchFolders = useCallback(async (currentPrefix: string) => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = { delimiter: '/' };
      if (currentPrefix) params.prefix = currentPrefix;
      const data = await apiGet<S3ListResponse>('/api/files/list', params);
      if (!data.success) {
        setError(data.error ?? 'Failed to list folders');
        return;
      }
      setFolders(data.folders);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list folders');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchFolders(prefix);
  }, [prefix, fetchFolders]);

  // Breadcrumb: bucket root + each path segment
  const breadcrumbItems = useMemo(() => {
    const items: { label: string; onClick?: () => void }[] = [
      { label: bucket || 'bucket', onClick: prefix ? () => setPrefix('') : undefined },
    ];
    if (prefix) {
      const parts = prefix.replace(/\/$/, '').split('/');
      for (let i = 0; i < parts.length; i++) {
        const partPrefix = `${parts.slice(0, i + 1).join('/')}/`;
        const isLast = i === parts.length - 1;
        items.push({ label: parts[i], onClick: isLast ? undefined : () => setPrefix(partPrefix) });
      }
    }
    return items;
  }, [bucket, prefix]);

  const atRoot = prefix === '';
  const currentFolderLabel = prefix.replace(/\/$/, '') || '(bucket root)';
  const destination = resolveDestination(prefix, mode, newName);

  // "Sync into this folder" is meaningless at the bucket root — force "new" there.
  useEffect(() => {
    if (atRoot && mode === 'existing') setMode('new');
  }, [atRoot, mode]);

  // Push the resolved destination up to the parent whenever it changes.
  useEffect(() => {
    onSelect(destination);
  }, [destination, onSelect]);

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
      {/* Header: bucket + breadcrumb + refresh */}
      <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 flex items-center gap-3">
        <CloudIcon className="w-5 h-5 text-nlr-blue flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <Breadcrumb items={breadcrumbItems} />
        </div>
        {suggestedName && (
          <button
            type="button"
            onClick={() => {
              setPrefix('');
              setMode('new');
              setNewName(suggestedName);
            }}
            className="text-xs text-nlr-blue hover:underline flex-shrink-0"
          >
            Use timestamp default
          </button>
        )}
        <button
          type="button"
          onClick={() => void fetchFolders(prefix)}
          className="text-gray-400 hover:text-nlr-blue transition-colors flex-shrink-0"
          aria-label="Refresh folder list"
        >
          <RefreshIcon className="w-4 h-4" />
        </button>
      </div>

      {/* Folder list */}
      <div className="max-h-64 overflow-y-auto">
        {loading ? (
          <div className="py-8 flex justify-center">
            <Spinner size="sm" message="Loading folders…" />
          </div>
        ) : error ? (
          <div className="px-4 py-6 text-sm text-red-600">{error}</div>
        ) : folders.length === 0 ? (
          <div className="px-4 py-6 text-sm text-gray-400 italic">No subfolders here.</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {folders.map((folder) => (
              <li key={folder.prefix}>
                <button
                  type="button"
                  onClick={() => setPrefix(folder.prefix)}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-left hover:bg-gray-50 transition-colors"
                >
                  <FolderIcon className="w-4 h-4 text-amber-400 flex-shrink-0" />
                  <span className="truncate text-gray-800">{folder.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Destination control */}
      <div className="border-t border-gray-200 p-4 space-y-3 bg-gray-50/50">
        {/* Sync into current folder */}
        <label
          className={`flex items-start gap-2 text-sm ${atRoot ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          <input
            type="radio"
            name="dest-mode"
            checked={mode === 'existing'}
            disabled={atRoot}
            onChange={() => setMode('existing')}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="font-medium text-nlr-text">Sync into this folder</span>
            <span className="block font-mono text-xs text-gray-500 truncate">
              {currentFolderLabel}
            </span>
          </span>
        </label>

        {/* Create new subfolder here */}
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="radio"
            name="dest-mode"
            checked={mode === 'new'}
            onChange={() => setMode('new')}
            className="mt-0.5"
          />
          <span className="min-w-0 flex-1">
            <span className="font-medium text-nlr-text">Create new subfolder here</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => {
                setMode('new');
                setNewName(e.target.value);
              }}
              placeholder="new-folder-name"
              className="mt-1 w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-nlr-blue"
            />
          </span>
        </label>

        {/* Live destination preview */}
        <p className="text-xs text-gray-500 pt-1">
          Files land at{' '}
          <span className="font-mono text-gray-700">
            s3://{bucket || '<bucket>'}/{destination || '…'}/
          </span>
        </p>
      </div>
    </div>
  );
}
