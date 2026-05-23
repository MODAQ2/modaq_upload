import { useState } from "react";
import type { UploadSession, UploadSessionFile } from "../../types/api.ts";

interface UploadSessionListProps {
  sessions: UploadSession[];
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    completed: "bg-green-100 text-green-700",
    skipped: "bg-gray-100 text-gray-600",
    failed: "bg-red-100 text-red-700",
  };
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded ${colors[status] ?? "bg-gray-100 text-gray-600"}`}>
      {status}
    </span>
  );
}

function SessionStatusSummary({ session }: { session: UploadSession }) {
  const parts: { text: string; color: string }[] = [];
  if (session.completed > 0) parts.push({ text: `${session.completed} completed`, color: "text-green-600" });
  if (session.failed > 0) parts.push({ text: `${session.failed} failed`, color: "text-red-600" });
  if (session.skipped > 0) parts.push({ text: `${session.skipped} skipped`, color: "text-gray-500" });

  return (
    <span className="text-sm">
      {parts.map((p, i) => (
        <span key={p.text}>
          {i > 0 && <span className="text-gray-400">, </span>}
          <span className={p.color}>{p.text}</span>
        </span>
      ))}
    </span>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function FileDetailTable({ files }: { files: UploadSessionFile[] }) {
  return (
    <div className="overflow-x-auto border border-gray-200 rounded">
      <table className="w-full text-xs">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Filename</th>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Size</th>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Status</th>
            <th className="px-3 py-2 text-left font-medium text-gray-500">Speed</th>
            <th className="px-3 py-2 text-left font-medium text-gray-500">S3 Path</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {files.map((file) => (
            <tr key={file.filename} className="hover:bg-gray-50">
              <td className="px-3 py-2 text-gray-900 font-mono">{file.filename}</td>
              <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{file.file_size_formatted}</td>
              <td className="px-3 py-2"><StatusBadge status={file.status} /></td>
              <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                {file.upload_speed_mbps ? `${file.upload_speed_mbps} Mbps` : "-"}
              </td>
              <td className="px-3 py-2 text-gray-500 font-mono text-[11px] max-w-xs truncate" title={file.s3_path}>
                {file.s3_path || "-"}
              </td>
            </tr>
          ))}
          {/* Show error rows separately for failed files */}
          {files
            .filter((f) => f.status === "failed" && f.error_message)
            .map((f) => (
              <tr key={`${f.filename}-error`} className="bg-red-50">
                <td colSpan={5} className="px-3 py-1.5 text-xs text-red-600">
                  {f.filename}: {f.error_message}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

export default function UploadSessionList({ sessions }: UploadSessionListProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  if (sessions.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
        No upload sessions found. Upload some files to see history here.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sessions.map((session, i) => {
        const isExpanded = expandedIndex === i;
        return (
          <div
            key={session.csv_path}
            className="bg-white rounded-lg border border-gray-200 overflow-hidden"
          >
            {/* Session header row */}
            <button
              onClick={() => setExpandedIndex(isExpanded ? null : i)}
              className="w-full flex items-center gap-4 px-4 py-3 hover:bg-gray-50 transition-colors text-left"
            >
              {/* Chevron */}
              <svg
                className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>

              {/* Date + time */}
              <div className="min-w-[120px]">
                <div className="text-sm font-medium text-gray-900">{session.date}</div>
                <div className="text-xs text-gray-400">{session.time}</div>
              </div>

              {/* File count */}
              <div className="min-w-[80px]">
                <div className="text-sm text-gray-700">{session.total_files} files</div>
              </div>

              {/* Total size */}
              <div className="min-w-[80px]">
                <div className="text-sm text-gray-700">{session.total_bytes_formatted}</div>
              </div>

              {/* Status summary */}
              <div className="flex-1">
                <SessionStatusSummary session={session} />
              </div>

              {/* Duration + speed */}
              <div className="text-right shrink-0 min-w-[100px]">
                <div className="text-xs text-gray-500">
                  {session.total_duration_seconds > 0
                    ? formatDuration(session.total_duration_seconds)
                    : "-"}
                </div>
                <div className="text-xs text-gray-400">
                  {session.avg_speed_mbps > 0 ? `${session.avg_speed_mbps} Mbps` : ""}
                </div>
              </div>

              {/* Download link — stop propagation so clicking doesn't toggle expand */}
              <a
                href={`/api/logs/csv-download?path=${encodeURIComponent(session.csv_path)}`}
                download
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 px-2 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors"
                title="Download CSV"
              >
                CSV
              </a>
            </button>

            {/* Expanded file detail */}
            {isExpanded && (
              <div className="border-t border-gray-200 px-4 py-3">
                <FileDetailTable files={session.files} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
