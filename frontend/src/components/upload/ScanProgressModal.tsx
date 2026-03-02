/**
 * Modal overlay that shows folder scan progress.
 *
 * Displayed when scanning a folder with many files to give users
 * clear feedback about what's happening and how long it might take.
 */

import { useEffect, useRef, useState } from "react";
import { formatBytes } from "../../utils/format/bytes.ts";
import ProgressBar from "../common/ProgressBar.tsx";
import Spinner from "../common/Spinner.tsx";
import { XIcon } from "../../utils/icons.tsx";
import CancelScanModal from "./CancelScanModal.tsx";

interface ScanProgressModalProps {
  isOpen: boolean;
  foldersScanned: number;
  foldersTotal: number;
  totalFiles: number;
  totalSize: number;
  folderPath: string;
  onCancel: () => void;
}

export default function ScanProgressModal({
  isOpen,
  foldersScanned,
  foldersTotal,
  totalFiles,
  totalSize,
  folderPath,
  onCancel,
}: ScanProgressModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  // Calculate scan progress percentage
  const progressPercent = foldersTotal > 0 ? Math.round((foldersScanned / foldersTotal) * 100) : 0;

  const handleCancelClick = () => {
    setShowCancelConfirm(true);
  };

  const handleConfirmCancel = () => {
    setShowCancelConfirm(false);
    onCancel();
  };

  // Handle Escape key - show confirmation
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") handleCancelClick();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  if (!isOpen) return null;

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === backdropRef.current) handleCancelClick();
  }

  return (
    <>
    <div
      ref={backdropRef}
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center animate-[fadeIn_0.15s_ease-out]"
      onClick={handleBackdropClick}
    >
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 overflow-hidden">
        <div className="p-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-3">
            <Spinner size="md" />
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Scanning Folder</h3>
              <p className="text-sm text-gray-500 mt-1">
                Searching for MCAP files and checking upload status...
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCancelClick}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            title="Cancel scan"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Folder path */}
        <div className="mb-6 p-3 bg-gray-50 rounded-lg">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Scanning</p>
          <p className="text-sm text-gray-900 font-mono truncate" title={folderPath}>
            {folderPath}
          </p>
        </div>

        {/* Progress bar */}
        {foldersTotal > 0 && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">Progress</span>
              <span className="text-sm font-bold text-nlr-blue">{progressPercent}%</span>
            </div>
            <ProgressBar percent={progressPercent} color="bg-nlr-blue" />
            <p className="text-xs text-gray-500 mt-2">
              {foldersScanned} of {foldersTotal} folders scanned
            </p>
          </div>
        )}

        {/* Progress stats */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <StatCard value={foldersScanned} label="Folders Scanned" />
          <StatCard value={totalFiles} label="Files Found" />
          <StatCard value={formatBytes(totalSize)} label="Total Size" />
        </div>

        {/* Info message */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <p className="text-sm text-blue-800">
            <strong>Note:</strong> Scanning large folders with thousands of files may take a few
            minutes. Each file is checked against the upload cache to determine if it's already been
            uploaded to S3.
          </p>
        </div>

        {/* Cancel button */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleCancelClick}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
          >
            Cancel Scan
          </button>
        </div>
        </div>
      </div>
    </div>
    {/* Cancel confirmation modal */}
    <CancelScanModal
      isOpen={showCancelConfirm}
      onClose={() => setShowCancelConfirm(false)}
      onConfirm={handleConfirmCancel}
      foldersScanned={foldersScanned}
      filesFound={totalFiles}
    />
  </>
  );
}

function StatCard({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3 text-center">
      <div className="text-2xl font-bold text-nlr-blue">
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      <div className="text-xs text-gray-500 mt-1">{label}</div>
    </div>
  );
}
