import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { apiGet } from '../../api/client.ts';
import { useAppStore } from '../../stores/appStore.ts';
import type { S3DownloadResponse, S3File, S3Folder } from '../../types/api.ts';
import { DownloadIcon, FileIcon, FolderIcon, SpinnerIcon } from '../../utils/icons.tsx';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface FileListProps {
  folders: S3Folder[];
  files: S3File[];
  onNavigate: (prefix: string) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

// Folders render first, then files, in a single virtualized list.
type Row = { type: 'folder'; folder: S3Folder } | { type: 'file'; file: S3File };

export default function FileList({
  folders,
  files,
  onNavigate,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: FileListProps) {
  const addNotification = useAppStore((s) => s.addNotification);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<Row[]>(
    () => [
      ...folders.map((folder): Row => ({ type: 'folder', folder })),
      ...files.map((file): Row => ({ type: 'file', file })),
    ],
    [folders, files],
  );

  // Virtualize the rows so folders with thousands of files render only the
  // handful currently on screen rather than mounting every row. Rows are a fixed
  // single-line height, so no per-row measurement is needed.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 49,
    overscan: 12,
  });

  const handleDownload = async (file: S3File) => {
    setDownloadingKey(file.key);
    try {
      const data = await apiGet<S3DownloadResponse>('/api/files/download', { key: file.key });
      if (!data.success) {
        addNotification('error', data.error ?? `Failed to download ${file.name}`);
        return;
      }
      // Navigating to the presigned URL triggers the browser download
      // (the URL sets Content-Disposition: attachment).
      const link = document.createElement('a');
      link.href = data.url;
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      addNotification(
        'error',
        err instanceof Error ? err.message : `Failed to download ${file.name}`,
      );
    } finally {
      setDownloadingKey(null);
    }
  };

  if (folders.length === 0 && files.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <FolderIcon className="mx-auto h-12 w-12 text-gray-300 mb-3" />
        <p className="text-sm">No files or folders found at this location.</p>
      </div>
    );
  }

  return (
    <>
      <div ref={parentRef} className="max-h-[600px] overflow-y-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vItem) => {
            const row = rows[vItem.index];
            return (
              <div
                key={vItem.key}
                data-index={vItem.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${vItem.size}px`,
                  transform: `translateY(${vItem.start}px)`,
                }}
                className="border-b border-gray-100"
              >
                {row.type === 'folder' ? (
                  <button
                    type="button"
                    onClick={() => onNavigate(row.folder.prefix)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 text-left transition-colors"
                  >
                    <FolderIcon className="h-5 w-5 text-nlr-yellow" />
                    <span className="text-sm font-medium text-gray-900">{row.folder.name}</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
                    <FileIcon className="h-5 w-5 text-gray-400" />
                    <div className="flex-1 min-w-0">
                      <p
                        className="text-sm font-medium text-gray-900 truncate"
                        title={row.file.name}
                      >
                        {row.file.name}
                      </p>
                    </div>
                    <span className="text-xs text-gray-500 whitespace-nowrap">
                      {formatBytes(row.file.size)}
                    </span>
                    <span className="text-xs text-gray-400 whitespace-nowrap">
                      {formatDate(row.file.last_modified)}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDownload(row.file)}
                      disabled={downloadingKey === row.file.key}
                      title={`Download ${row.file.name}`}
                      aria-label={`Download ${row.file.name}`}
                      className="p-1.5 rounded text-gray-400 hover:text-nlr-blue hover:bg-gray-100 disabled:opacity-50 transition-colors"
                    >
                      {downloadingKey === row.file.key ? (
                        <SpinnerIcon className="h-4 w-4 animate-spin" />
                      ) : (
                        <DownloadIcon className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {hasMore && (
        <div className="flex justify-center p-4 border-t border-gray-100">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="flex items-center gap-2 text-sm text-nlr-blue hover:underline disabled:opacity-50 disabled:no-underline"
          >
            {loadingMore && <SpinnerIcon className="h-4 w-4 animate-spin" />}
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </>
  );
}
