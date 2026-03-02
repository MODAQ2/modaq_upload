import { useCallback, useState } from "react";
import { apiGet } from "../../api/client.ts";
import type { CsvFileInfo, CsvPreviewResponse } from "../../types/api.ts";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

interface CsvPreviewProps {
  csvFiles: CsvFileInfo[];
}

export default function CsvPreview({ csvFiles }: CsvPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<CsvPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const loadPreview = useCallback(async (path: string) => {
    // Toggle off if clicking same file
    if (previewPath === path) {
      setPreviewPath(null);
      setPreviewData(null);
      return;
    }

    setPreviewPath(path);
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const data = await apiGet<CsvPreviewResponse>("/api/logs/csv-preview", { path });
      setPreviewData(data);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to load preview");
    } finally {
      setPreviewLoading(false);
    }
  }, [previewPath]);

  if (csvFiles.length === 0) {
    return null;
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Collapsible header */}
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg className="h-5 w-5 text-nlr-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <span className="text-sm font-semibold text-gray-700">
            Upload Summaries ({csvFiles.length})
          </span>
        </div>
        <svg
          className={`w-5 h-5 text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`}
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
      </button>

      {expanded && (
        <div className="border-t border-gray-200">
          {/* CSV file list */}
          <div className="divide-y divide-gray-100">
            {csvFiles.map((file) => (
              <div key={file.path}>
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
                  <svg
                    className="h-4 w-4 text-gray-400 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{file.filename}</p>
                    <p className="text-xs text-gray-400">
                      {file.date} -- {formatBytes(file.size)}
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => loadPreview(file.path)}
                      className={`px-3 py-1 text-xs rounded border transition-colors ${
                        previewPath === file.path
                          ? "bg-nlr-blue text-white border-nlr-blue"
                          : "border-gray-300 text-gray-600 hover:bg-gray-100"
                      }`}
                    >
                      {previewPath === file.path ? "Hide" : "View"}
                    </button>
                    <a
                      href={`/api/logs/csv-download?path=${encodeURIComponent(file.path)}`}
                      className="px-3 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors"
                      download
                    >
                      Download
                    </a>
                  </div>
                </div>

                {/* Inline preview */}
                {previewPath === file.path && (
                  <div className="px-4 pb-3">
                    {previewLoading && (
                      <div className="text-sm text-gray-500 py-4 text-center">
                        Loading preview...
                      </div>
                    )}
                    {previewError && (
                      <div className="text-sm text-red-600 py-4 text-center">{previewError}</div>
                    )}
                    {previewData && !previewLoading && (
                      <div className="overflow-x-auto border border-gray-200 rounded">
                        <table className="w-full text-xs">
                          <thead className="bg-gray-50">
                            <tr>
                              {previewData.columns.map((col) => (
                                <th
                                  key={col}
                                  className="px-3 py-2 text-left font-medium text-gray-500 uppercase whitespace-nowrap"
                                >
                                  {col}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {previewData.rows.map((row, i) => (
                              <tr key={i} className="hover:bg-gray-50">
                                {previewData.columns.map((col) => (
                                  <td
                                    key={col}
                                    className="px-3 py-2 text-gray-700 whitespace-nowrap"
                                  >
                                    {row[col] ?? ""}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
