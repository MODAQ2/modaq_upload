/**
 * Phase-aware footer with action buttons below the unified file table.
 *
 * - Review: Back + Start Upload
 * - Upload: Cancel Upload
 * - Summary: info blurb + Download CSV + Upload More
 */

import { Link } from "react-router-dom";
import type { UploadPhase } from "../../types/upload.ts";
import { ChevronRightIcon, XCircleIcon, DownloadIcon, UploadIcon } from "../../utils/icons.tsx";

interface UploadFooterProps {
  phase: UploadPhase;

  // Review
  onBack?: () => void;
  onStartUpload?: () => void;
  selectedNewCount?: number;

  // Upload
  onCancel?: () => void;
  isRunning?: boolean;

  // Summary
  onDownloadCsv?: () => void;
  onUploadMore?: () => void;
  failedCount?: number;
}

export default function UploadFooter({
  phase,
  onBack,
  onStartUpload,
  selectedNewCount = 0,
  onCancel,
  isRunning = false,
  onDownloadCsv,
  onUploadMore,
}: UploadFooterProps) {
  if (phase === "review") {
    return (
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 border border-gray-300 rounded hover:bg-gray-50"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onStartUpload}
          disabled={selectedNewCount === 0}
          className="px-6 py-2 text-sm font-medium rounded transition-colors
            bg-nlr-blue text-white hover:bg-blue-700
            disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed"
        >
          Start Upload ({selectedNewCount.toLocaleString()} file{selectedNewCount !== 1 ? "s" : ""})
          <ChevronRightIcon className="w-4 h-4 ml-1 inline-block" strokeWidth={2.5} />
        </button>
      </div>
    );
  }

  if (phase === "uploading") {
    return (
      <div className="flex justify-center pt-2">
        {isRunning && (
          <button
            type="button"
            onClick={onCancel}
            className="px-6 py-2 text-sm font-medium text-red-600 border border-red-300 rounded hover:bg-red-50 transition-colors"
          >
            <XCircleIcon className="w-4 h-4 mr-1 inline-block" />
            Cancel Upload
          </button>
        )}
      </div>
    );
  }

  // Summary
  return (
    <div className="space-y-3 pt-2">
      <p className="text-xs text-gray-500 text-center">
        These results have been saved and can be reviewed anytime on the{" "}
        <Link to="/logs" className="text-nlr-blue hover:underline font-medium">History</Link> page.
      </p>
      <div className="flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={onDownloadCsv}
          title="Export a spreadsheet of all files and their upload status"
          className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
        >
          <DownloadIcon className="w-4 h-4 mr-1 inline-block" />
          Export Summary CSV
        </button>
        <button
          type="button"
          onClick={onUploadMore}
          className="px-6 py-2 text-sm font-medium rounded transition-colors bg-nlr-blue text-white hover:bg-blue-700"
        >
          <UploadIcon className="w-4 h-4 mr-1 inline-block" />
          Upload More
        </button>
      </div>
    </div>
  );
}
