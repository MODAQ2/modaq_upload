/**
 * Batch progress indicator for large upload jobs.
 *
 * Shows:
 * - Current batch number (e.g., "Batch 5/200")
 * - Progress bar for current batch
 * - Cumulative job statistics
 * - Active files being processed (max 8)
 *
 * Used during upload phase for jobs processed in batches.
 */

import type { BatchState } from "../../types/api.ts";
import ProgressBar from "../common/ProgressBar.tsx";
import Spinner from "../common/Spinner.tsx";
import { InfoIcon } from "../../utils/icons.tsx";

interface BatchProgressProps {
  /** Current batch state */
  batchState: BatchState | null;

  /** Overall job progress (0-100) */
  jobProgressPercent: number;

  /** Total files completed across all batches */
  jobFilesCompleted: number;

  /** Total files in entire job */
  jobFilesTotal: number;

  /** Total files uploaded successfully across all batches */
  jobFilesUploaded: number;

  /** Total files failed across all batches */
  jobFilesFailed: number;

  /** Whether the job is actively running */
  isRunning: boolean;
}

export default function BatchProgress({
  batchState,
  jobProgressPercent,
  jobFilesCompleted,
  jobFilesTotal,
  jobFilesUploaded,
  jobFilesFailed,
  isRunning,
}: BatchProgressProps) {
  if (!batchState) {
    return null;
  }

  const batchProgressPercent = batchState.files_in_batch > 0
    ? (batchState.files_processed / batchState.files_in_batch) * 100
    : 0;

  const currentBatch = batchState.batch_id + 1; // 0-indexed to 1-indexed
  const totalBatches = batchState.total_batches;

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Batch indicator */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900">
              Batch {currentBatch} of {totalBatches}
            </h3>
            {isRunning && batchState.status === "processing" && <Spinner size="sm" />}
          </div>
          <div className="text-xs text-gray-500">
            {batchState.files_in_batch} files in this batch
          </div>
        </div>

        {/* Batch progress */}
        <ProgressBar
          percent={batchProgressPercent}
          label={`${batchState.files_processed} / ${batchState.files_in_batch} files processed`}
          color="bg-nlr-blue"
        />

        {/* Batch stats */}
        <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
          <span>
            Uploaded: {batchState.files_uploaded} | Failed: {batchState.files_failed}
          </span>
          {batchState.status === "completed" && batchState.duration_seconds && (
            <span>{batchState.duration_seconds.toFixed(1)}s</span>
          )}
        </div>
      </div>

      {/* Overall job progress */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">Overall Progress</h3>
        </div>

        <ProgressBar
          percent={jobProgressPercent}
          label={`${jobFilesCompleted} / ${jobFilesTotal} total files`}
          color="bg-green-600"
        />

        {/* Job stats */}
        <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
          <span>
            Uploaded: {jobFilesUploaded} | Failed: {jobFilesFailed}
          </span>
          <span>
            {totalBatches - currentBatch} batch{totalBatches - currentBatch !== 1 ? "es" : ""} remaining
          </span>
        </div>
      </div>

      {/* Info banner */}
      {totalBatches > 10 && (
        <div className="flex items-start gap-2 p-3 bg-blue-50 rounded-lg border border-blue-200 text-sm text-blue-700">
          <InfoIcon className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <strong>Large job detected:</strong> Files are being processed in batches
            to optimize memory usage and performance. Full results will be available
            after completion.
          </div>
        </div>
      )}
    </div>
  );
}
