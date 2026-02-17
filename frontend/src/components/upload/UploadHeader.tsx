/**
 * Phase-aware header that sits above the unified file table.
 *
 * - Review: stat cards + scanning indicator
 * - Upload: progress bar + counters + ETA
 * - Summary: summary stat cards + job status headline
 *
 * Uses crossfade transitions between phases.
 */

import type { UploadJob } from "../../types/api.ts";
import type { StatusFilter, UploadPhase } from "../../types/upload.ts";
import { formatBytes } from "../../utils/format/bytes.ts";
import { formatSpeed } from "../../utils/format/speed.ts";
import { formatDuration, formatEta } from "../../utils/format/time.ts";
import ProgressBar from "../common/ProgressBar.tsx";
import Spinner from "../common/Spinner.tsx";
import StatCard from "../common/StatCard.tsx";
import { WarningIcon } from "../../utils/icons.tsx";

interface UploadHeaderProps {
  phase: UploadPhase;

  // Review data
  totals: { totalFiles: number; alreadyUploaded: number; totalSize: number };
  isScanning: boolean;
  foldersFound: number;

  // Upload data
  progressPercent: number;
  filesProcessed: number;
  totalFiles: number;
  statusCounts: { uploaded: number; skipped: number; failed: number };
  eta: number | null;
  isRunning: boolean;
  uploadedBytesFormatted: string;
  totalBytesFormatted: string;

  // Summary data
  job: UploadJob | null;

  // Clickable status counters
  onFilterClick?: (filter: StatusFilter) => void;
}

export default function UploadHeader({
  phase,
  totals,
  isScanning,
  foldersFound,
  progressPercent,
  filesProcessed,
  totalFiles,
  statusCounts,
  eta,
  isRunning,
  uploadedBytesFormatted,
  totalBytesFormatted,
  job,
  onFilterClick,
}: UploadHeaderProps) {
  if (phase === "review") {
    return <ReviewHeader totals={totals} isScanning={isScanning} foldersFound={foldersFound} />;
  }

  if (phase === "uploading") {
    return (
      <UploadingHeader
        progressPercent={progressPercent}
        filesProcessed={filesProcessed}
        totalFiles={totalFiles}
        statusCounts={statusCounts}
        eta={eta}
        isRunning={isRunning}
        uploadedBytesFormatted={uploadedBytesFormatted}
        totalBytesFormatted={totalBytesFormatted}
        onFilterClick={onFilterClick}
      />
    );
  }

  return <SummaryHeader job={job} onFilterClick={onFilterClick} />;
}

// ── Review phase ──

function ReviewHeader({
  totals,
  isScanning,
  foldersFound,
}: {
  totals: { totalFiles: number; alreadyUploaded: number; totalSize: number };
  isScanning: boolean;
  foldersFound: number;
}) {
  const newFiles = totals.totalFiles - totals.alreadyUploaded;
  return (
    <div className="space-y-3 animate-in fade-in duration-200">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard value={totals.totalFiles.toLocaleString()} label="Total Files" color="text-nlr-blue" />
        <StatCard value={formatBytes(totals.totalSize)} label="Total Size" color="text-nlr-blue" />
        <StatCard value={totals.alreadyUploaded.toLocaleString()} label="Already Uploaded" color="text-yellow-500" />
        <StatCard value={newFiles.toLocaleString()} label="New Files" color="text-green-600" />
      </div>

      {isScanning && (
        <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
          <Spinner size="sm" />
          <span className="text-sm text-blue-700">
            Scanning folders... ({foldersFound} folder{foldersFound !== 1 ? "s" : ""} found so far)
          </span>
        </div>
      )}
    </div>
  );
}

// ── Upload phase ──

function UploadingHeader({
  progressPercent,
  filesProcessed,
  totalFiles,
  statusCounts,
  eta,
  isRunning,
  uploadedBytesFormatted,
  totalBytesFormatted,
  onFilterClick,
}: {
  progressPercent: number;
  filesProcessed: number;
  totalFiles: number;
  statusCounts: { uploaded: number; skipped: number; failed: number };
  eta: number | null;
  isRunning: boolean;
  uploadedBytesFormatted: string;
  totalBytesFormatted: string;
  onFilterClick?: (filter: StatusFilter) => void;
}) {
  return (
    <div className="space-y-3 animate-in fade-in duration-200">
      {/* Progress bar card */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900">
            {isRunning ? "Uploading..." : "Upload Complete"}
          </h3>
          {isRunning && <Spinner size="sm" />}
        </div>

        <ProgressBar
          percent={progressPercent}
          label={`${filesProcessed} / ${totalFiles} files`}
        />

        <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
          <span>
            {uploadedBytesFormatted || "0 B"} / {totalBytesFormatted || "0 B"}
          </span>
          <span>ETA: {formatEta(eta)}</span>
        </div>
      </div>

      {/* Clickable status counters */}
      <div className="grid grid-cols-3 gap-3">
        <StatusCounterButton
          count={statusCounts.uploaded}
          label="Uploaded"
          color="text-green-600"
          bgColor="bg-green-50"
          borderColor="border-green-200"
          onClick={() => onFilterClick?.("completed")}
        />
        <StatusCounterButton
          count={statusCounts.skipped}
          label="Skipped"
          color="text-yellow-600"
          bgColor="bg-yellow-50"
          borderColor="border-yellow-200"
          onClick={() => onFilterClick?.("skipped")}
        />
        <StatusCounterButton
          count={statusCounts.failed}
          label="Failed"
          color="text-red-600"
          bgColor="bg-red-50"
          borderColor="border-red-200"
          onClick={() => onFilterClick?.("failed")}
        />
      </div>
    </div>
  );
}

// ── Summary phase ──

function SummaryHeader({
  job,
  onFilterClick,
}: {
  job: UploadJob | null;
  onFilterClick?: (filter: StatusFilter) => void;
}) {
  if (!job) return null;

  const headlineColor = job.files_failed > 0
    ? "text-yellow-600"
    : job.cancelled
      ? "text-gray-600"
      : "text-green-600";

  const headlineText = job.cancelled
    ? "Upload Cancelled"
    : job.files_failed > 0 && job.files_uploaded > 0
      ? "Upload Partial Success"
      : job.files_failed > 0
        ? "Upload Failed"
        : "Upload Complete";

  return (
    <div className="space-y-3 animate-in fade-in duration-200">
      <div className="text-center">
        <h3 className={`text-lg font-bold ${headlineColor}`}>{headlineText}</h3>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <button
          type="button"
          onClick={() => onFilterClick?.("completed")}
          className="text-left"
        >
          <StatCard value={job.files_uploaded.toLocaleString()} label="Uploaded" color="text-green-600" />
        </button>
        <button
          type="button"
          onClick={() => onFilterClick?.("skipped")}
          className="text-left"
        >
          <StatCard value={job.files_skipped.toLocaleString()} label="Skipped" color="text-yellow-500" />
        </button>
        <button
          type="button"
          onClick={() => onFilterClick?.("failed")}
          className="text-left"
        >
          <StatCard value={job.files_failed.toLocaleString()} label="Failed" color="text-red-500" />
        </button>
        <StatCard value={job.successfully_uploaded_bytes_formatted} label="Data Uploaded" color="text-nlr-blue" />
        <StatCard value={formatDuration(job.total_upload_duration_seconds)} label="Duration" color="text-nlr-blue" />
        <StatCard value={formatSpeed(job.average_upload_speed_mbps)} label="Avg Speed" color="text-nlr-blue" />
      </div>

      {job.files_failed > 0 && (
        <div className="flex items-center gap-2 p-3 bg-red-50 rounded-lg border border-red-200 text-sm text-red-700">
          <WarningIcon className="w-4 h-4 flex-shrink-0" />
          <span>
            <strong>{job.files_failed}</strong> file{job.files_failed !== 1 ? "s" : ""} failed to upload.
            <button
              type="button"
              onClick={() => onFilterClick?.("failed")}
              className="ml-1 text-red-800 underline hover:no-underline"
            >
              Show failed files
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

// ── Clickable status counter ──

function StatusCounterButton({
  count,
  label,
  color,
  bgColor,
  borderColor,
  onClick,
}: {
  count: number;
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${bgColor} ${borderColor} border rounded-lg p-3 text-center hover:opacity-80 transition-opacity cursor-pointer`}
    >
      <div className={`text-xl font-bold ${color}`}>{count.toLocaleString()}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </button>
  );
}
