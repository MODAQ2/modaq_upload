/**
 * Delete page — 5-step workflow for deleting local files after S3 upload.
 *
 * Step 1: FolderBrowser — select a folder
 * Step 2: Review matched files with stats
 * Step 3: Confirmation (type DELETE + checkbox)
 * Step 4: Progress (verification + deletion with SSE)
 * Step 5: Summary with results
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import ProgressBar from "../components/common/ProgressBar.tsx";
import StatCard from "../components/common/StatCard.tsx";
import DeleteConfirmation from "../components/delete/DeleteConfirmation.tsx";
import DeleteStepper from "../components/delete/DeleteStepper.tsx";
import FolderBrowser from "../components/upload/FolderBrowser.tsx";
import { useDeleteJob } from "../hooks/useDeleteJob.ts";
import { useDeleteScan } from "../hooks/useDeleteScan.ts";
import { useAppStore } from "../stores/appStore.ts";
import { useDeleteStore, type DeleteStep } from "../stores/deleteStore.ts";
import type { DeleteScanFile } from "../types/delete.ts";
import { formatBytes } from "../utils/format/bytes.ts";

/** Status badge colors for file table. */
function statusBadge(status: string) {
  switch (status) {
    case "deleted":
      return "bg-green-100 text-green-700";
    case "verified":
      return "bg-blue-100 text-blue-700";
    case "verifying":
    case "deleting":
      return "bg-yellow-100 text-yellow-700";
    case "mismatch":
      return "bg-orange-100 text-orange-700";
    case "failed":
      return "bg-red-100 text-red-700";
    case "cancelled":
      return "bg-gray-100 text-gray-600";
    default:
      return "bg-gray-100 text-gray-600";
  }
}

/** Truncate path for display, showing last N segments. */
function truncatePath(path: string, segments = 3): string {
  const parts = path.split("/");
  if (parts.length <= segments) return path;
  return `.../${parts.slice(-segments).join("/")}`;
}

export default function DeletePage() {
  const {
    step,
    setStep,
    folderPath,
    setFolderPath,
    scanResults,
    scanTotalSize,
    completedJob,
    isDeleting,
    reset,
  } = useDeleteStore();

  const defaultUploadFolder = useAppStore(
    (s) => s.settings?.default_upload_folder,
  );

  const { scan, isScanning } = useDeleteScan();
  const deleteJob = useDeleteJob();

  // Pagination for file table
  const [page, setPage] = useState(0);
  const pageSize = 50;

  // ── Step transitions ──

  const handleFolderSelected = useCallback(
    async (path: string) => {
      setFolderPath(path);
      setStep(2);
      await scan(path);
    },
    [setFolderPath, setStep, scan],
  );

  const handleConfirmDelete = useCallback(async () => {
    setStep(4);
    await deleteJob.startDelete();
  }, [setStep, deleteJob]);

  // Auto-advance from Step 4 to Step 5 when deletion completes
  useEffect(() => {
    if (step === 4 && !deleteJob.isRunning && completedJob) {
      setStep(5);
    }
  }, [step, deleteJob.isRunning, completedJob, setStep]);

  const handleStartOver = useCallback(() => {
    reset();
  }, [reset]);

  const handleBack = useCallback(() => {
    if (step === 2) {
      reset();
    } else if (step === 3) {
      setStep(2);
    }
  }, [step, reset, setStep]);

  const handleStepClick = useCallback(
    (s: DeleteStep) => {
      if (s === 1) reset();
      else if (s === 2 && step > 2) setStep(2);
    },
    [reset, step, setStep],
  );

  // ── Derived data ──

  const progressPercent = useMemo(() => {
    if (deleteJob.totalFiles === 0) return 0;
    return Math.round(
      (deleteJob.filesProcessed / deleteJob.totalFiles) * 100,
    );
  }, [deleteJob.filesProcessed, deleteJob.totalFiles]);

  const completionFiles: DeleteScanFile[] = completedJob?.files ?? [];

  // Paginated files for review step
  const paginatedReviewFiles = useMemo(() => {
    const start = page * pageSize;
    return scanResults.slice(start, start + pageSize);
  }, [scanResults, page]);

  const totalPages = Math.ceil(scanResults.length / pageSize);

  // ── Render ──

  return (
    <div>
      <DeleteStepper
        currentStep={step}
        onStepClick={handleStepClick}
        isDeleting={isDeleting}
      />

      {/* Step 1: Folder Selection */}
      {step === 1 && (
        <FolderBrowser
          onFolderSelected={handleFolderSelected}
          initialPath={folderPath || defaultUploadFolder || undefined}
          mode="delete"
        />
      )}

      {/* Step 2: Review */}
      {step === 2 && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <StatCard
              value={scanResults.length}
              label="Files Matched"
              color="text-nlr-blue"
            />
            <StatCard
              value={formatBytes(scanTotalSize)}
              label="Total Size"
              color="text-nlr-blue"
            />
            <StatCard
              value={isScanning ? "Scanning..." : "Ready"}
              label="Status"
              color={isScanning ? "text-amber-600" : "text-green-600"}
            />
          </div>

          {scanResults.length === 0 && !isScanning && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
              No uploaded MCAP files found in this folder. Only files previously
              uploaded through this application can be cleared.
            </div>
          )}

          {scanResults.length > 0 && (
            <>
              <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium text-gray-600">
                        Filename
                      </th>
                      <th className="text-left px-4 py-2 font-medium text-gray-600">
                        Size
                      </th>
                      <th className="text-left px-4 py-2 font-medium text-gray-600">
                        S3 Path
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {paginatedReviewFiles.map((f) => (
                      <tr key={f.local_path} className="hover:bg-gray-50">
                        <td className="px-4 py-2 font-mono text-xs">
                          {f.filename}
                        </td>
                        <td className="px-4 py-2 text-gray-600">
                          {formatBytes(f.file_size)}
                        </td>
                        <td
                          className="px-4 py-2 text-gray-500 text-xs"
                          title={f.s3_path}
                        >
                          {truncatePath(f.s3_path)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between text-sm text-gray-600">
                  <span>
                    Showing {page * pageSize + 1}–
                    {Math.min((page + 1) * pageSize, scanResults.length)} of{" "}
                    {scanResults.length}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0}
                      className="px-3 py-1 border rounded disabled:opacity-50"
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setPage((p) => Math.min(totalPages - 1, p + 1))
                      }
                      disabled={page >= totalPages - 1}
                      className="px-3 py-1 border rounded disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleBack}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Back
            </button>
            {scanResults.length > 0 && (
              <button
                type="button"
                onClick={() => setStep(3)}
                disabled={isScanning}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                Continue to Confirmation
              </button>
            )}
          </div>
        </div>
      )}

      {/* Step 3: Confirmation */}
      {step === 3 && (
        <DeleteConfirmation
          totalFiles={scanResults.length}
          totalSize={scanTotalSize}
          onConfirm={handleConfirmDelete}
          onBack={handleBack}
        />
      )}

      {/* Step 4: Deletion Progress */}
      {step === 4 && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <StatCard
              value={deleteJob.statusCounts.verified + deleteJob.statusCounts.deleted}
              label="Verified"
              color="text-blue-600"
            />
            <StatCard
              value={deleteJob.statusCounts.deleted}
              label="Cleared"
              color="text-green-600"
            />
            <StatCard
              value={deleteJob.statusCounts.mismatch + deleteJob.statusCounts.failed}
              label="Skipped"
              color="text-amber-600"
            />
          </div>

          <ProgressBar
            percent={progressPercent}
            label={
              deleteJob.jobStatus === "verifying"
                ? "Verifying files against S3..."
                : deleteJob.jobStatus === "deleting"
                  ? "Clearing verified files..."
                  : "Processing..."
            }
          />

          <button
            type="button"
            onClick={deleteJob.cancelDelete}
            className="px-4 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Step 5: Summary */}
      {step === 5 && completedJob && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard
              value={completedJob.status_counts.deleted ?? 0}
              label="Cleared"
              color="text-green-600"
            />
            <StatCard
              value={completedJob.status_counts.mismatch ?? 0}
              label="Mismatched"
              color="text-amber-600"
            />
            <StatCard
              value={completedJob.status_counts.failed ?? 0}
              label="Failed"
              color="text-red-600"
            />
            <StatCard
              value={formatBytes(completedJob.total_deleted_size)}
              label="Space Freed"
              color="text-nlr-blue"
            />
          </div>

          {/* Result file table */}
          {completionFiles.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-gray-600">
                      Filename
                    </th>
                    <th className="text-left px-4 py-2 font-medium text-gray-600">
                      Size
                    </th>
                    <th className="text-left px-4 py-2 font-medium text-gray-600">
                      Status
                    </th>
                    <th className="text-left px-4 py-2 font-medium text-gray-600">
                      Details
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {completionFiles.map((f) => (
                    <tr key={f.local_path} className="hover:bg-gray-50">
                      <td className="px-4 py-2 font-mono text-xs">
                        {f.filename}
                      </td>
                      <td className="px-4 py-2 text-gray-600">
                        {formatBytes(f.file_size)}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(f.status)}`}
                        >
                          {f.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500">
                        {f.error_message || (f.verification === "md5+size" ? "Verified: MD5 + size" : f.verification === "size" ? "Verified: size (multipart ETag)" : "—")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button
            type="button"
            onClick={handleStartOver}
            className="px-4 py-2 text-sm font-medium text-white bg-nlr-blue rounded-md hover:bg-nlr-blue-light"
          >
            Clear More Files
          </button>
        </div>
      )}
    </div>
  );
}
