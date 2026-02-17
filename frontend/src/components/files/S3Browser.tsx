import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../api/client.ts";
import type { S3File, S3Folder, S3ListResponse } from "../../types/api.ts";
import Breadcrumb from "../common/Breadcrumb.tsx";
import Spinner from "../common/Spinner.tsx";
import FileList from "./FileList.tsx";

interface S3BrowserProps {
  bucketName: string;
  region: string;
}

export default function S3Browser({ bucketName, region }: S3BrowserProps) {
  const [prefix, setPrefix] = useState("");
  const [folders, setFolders] = useState<S3Folder[]>([]);
  const [files, setFiles] = useState<S3File[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Build breadcrumb items from the current prefix
  const breadcrumbItems = (() => {
    const items = [
      {
        label: bucketName,
        onClick: prefix ? () => setPrefix("") : undefined,
      },
    ];

    if (prefix) {
      const parts = prefix.replace(/\/$/, "").split("/");
      for (let i = 0; i < parts.length; i++) {
        const partPrefix = parts.slice(0, i + 1).join("/") + "/";
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
      const params: Record<string, string> = { delimiter: "/" };
      if (currentPrefix) params.prefix = currentPrefix;
      const data = await apiGet<S3ListResponse>("/api/files/list", params);
      if (!data.success) {
        setError(data.error ?? "Failed to list objects");
        return;
      }
      setFolders(data.folders);
      setFiles(data.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch files");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchObjects(prefix);
  }, [prefix, fetchObjects]);

  const navigateToPrefix = useCallback((newPrefix: string) => {
    setPrefix(newPrefix);
  }, []);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      {/* Header: Bucket info + breadcrumb */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center gap-2 mb-2">
          <svg
            className="h-5 w-5 text-nlr-blue"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"
            />
          </svg>
          <span className="text-sm text-gray-500">
            {bucketName}
            <span className="ml-2 text-xs text-gray-400">({region})</span>
          </span>
        </div>
        <Breadcrumb items={breadcrumbItems} />
      </div>

      {/* Content */}
      <div className="min-h-[300px]">
        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner message="Loading files..." />
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <p className="text-sm text-red-600 mb-3">{error}</p>
            <button
              onClick={() => fetchObjects(prefix)}
              className="text-sm text-nlr-blue hover:underline"
            >
              Retry
            </button>
          </div>
        ) : (
          <FileList folders={folders} files={files} onNavigate={navigateToPrefix} />
        )}
      </div>
    </div>
  );
}
