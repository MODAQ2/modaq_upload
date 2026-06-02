import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../../api/client.ts';
import type { S3File, S3Folder, S3ListResponse, S3StatsResponse } from '../../types/api.ts';
import { CloudIcon } from '../../utils/icons.tsx';
import Breadcrumb from '../common/Breadcrumb.tsx';
import FileList from './FileList.tsx';

interface S3BrowserProps {
  bucketName: string;
  region: string;
}

export default function S3Browser({ bucketName, region }: S3BrowserProps) {
  const [prefix, setPrefix] = useState('');
  const [folders, setFolders] = useState<S3Folder[]>([]);
  const [files, setFiles] = useState<S3File[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<S3StatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Build breadcrumb items from the current prefix
  const breadcrumbItems = (() => {
    const items = [
      {
        label: bucketName,
        onClick: prefix ? () => setPrefix('') : undefined,
      },
    ];

    if (prefix) {
      const parts = prefix.replace(/\/$/, '').split('/');
      for (let i = 0; i < parts.length; i++) {
        const partPrefix = `${parts.slice(0, i + 1).join('/')}/`;
        const isLast = i === parts.length - 1;
        items.push({
          label: parts[i],
          onClick: isLast ? undefined : () => setPrefix(partPrefix),
        });
      }
    }

    return items;
  })();

  const fetchObjects = useCallback(async (currentPrefix: string) => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = { delimiter: '/' };
      if (currentPrefix) params.prefix = currentPrefix;
      const data = await apiGet<S3ListResponse>('/api/files/list', params);
      if (!data.success) {
        setError(data.error ?? 'Failed to list objects');
        return;
      }
      setFolders(data.folders);
      setFiles(data.files);
      setNextToken(data.next_token ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch files');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch the next page and append, deduping folders that span page boundaries.
  const loadMore = useCallback(async () => {
    if (!nextToken || loadingMore) return;
    setLoadingMore(true);
    try {
      const params: Record<string, string> = { delimiter: '/', token: nextToken };
      if (prefix) params.prefix = prefix;
      const data = await apiGet<S3ListResponse>('/api/files/list', params);
      if (!data.success) {
        setError(data.error ?? 'Failed to load more objects');
        return;
      }
      setFolders((prev) => {
        const seen = new Set(prev.map((f) => f.prefix));
        return [...prev, ...data.folders.filter((f) => !seen.has(f.prefix))];
      });
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.key));
        return [...prev, ...data.files.filter((f) => !seen.has(f.key))];
      });
      setNextToken(data.next_token ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more files');
    } finally {
      setLoadingMore(false);
    }
  }, [nextToken, loadingMore, prefix]);

  // Accurate counts for the current level. Fetched separately because the file
  // list is paginated (one page at a time), so its loaded length isn't the total.
  const fetchStats = useCallback(async (currentPrefix: string) => {
    setStatsLoading(true);
    setStats(null);
    try {
      const params: Record<string, string> = { delimiter: '/' };
      if (currentPrefix) params.prefix = currentPrefix;
      const data = await apiGet<S3StatsResponse>('/api/files/stats', params);
      const valid =
        data.success &&
        typeof data.folder_count === 'number' &&
        typeof data.file_count === 'number';
      setStats(valid ? data : null);
    } catch {
      setStats(null); // Counts are non-critical; don't surface as an error.
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchObjects(prefix);
    void fetchStats(prefix);
  }, [prefix, fetchObjects, fetchStats]);

  const navigateToPrefix = useCallback((newPrefix: string) => {
    setPrefix(newPrefix);
  }, []);

  // A plain-language note summarizing the current folder's contents.
  const statsNote = (() => {
    if (statsLoading) return 'Counting items…';
    if (!stats) return null;
    const plural = (n: number, word: string) =>
      `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
    const folders = plural(stats.folder_count, 'subfolder');
    const files = plural(stats.file_count, 'file');
    return `This folder contains ${folders} and ${files}.`;
  })();

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      {/* Header: Bucket info + breadcrumb */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center gap-2 mb-2">
          <CloudIcon className="h-5 w-5 text-nlr-blue" />
          <span className="text-sm text-gray-500">
            {bucketName}
            <span className="ml-2 text-xs text-gray-400">({region})</span>
          </span>
        </div>
        <Breadcrumb items={breadcrumbItems} />
        {statsNote && <p className="text-xs text-gray-400 mt-2">{statsNote}</p>}
      </div>

      {/* Content */}
      <div className="min-h-[300px] relative">
        {/* Thin indeterminate bar across the top while a fetch is in flight.
            The list stays visible underneath rather than being replaced. */}
        {(loading || loadingMore) && (
          <div
            role="progressbar"
            aria-label="Loading files"
            className="absolute inset-x-0 top-0 h-0.5 bg-gray-100 overflow-hidden z-10"
          >
            <div className="scanning-bar h-0.5 bg-nlr-blue" />
          </div>
        )}

        {error ? (
          <div className="text-center py-12">
            <p className="text-sm text-red-600 mb-3">{error}</p>
            <button
              type="button"
              onClick={() => fetchObjects(prefix)}
              className="text-sm text-nlr-blue hover:underline"
            >
              Retry
            </button>
          </div>
        ) : loading && folders.length === 0 && files.length === 0 ? (
          // First load with nothing to show yet — leave the panel empty (the bar
          // signals activity) rather than flashing the "no files" empty state.
          <div className="py-12" />
        ) : (
          <FileList
            folders={folders}
            files={files}
            onNavigate={navigateToPrefix}
            hasMore={nextToken != null}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
          />
        )}
      </div>
    </div>
  );
}
