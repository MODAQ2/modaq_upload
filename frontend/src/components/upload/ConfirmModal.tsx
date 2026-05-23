/**
 * Pre-upload confirmation modal.
 *
 * Shows file count and total size, with a "Force re-upload duplicates" toggle
 * that dynamically updates the file count.
 */

import { useMemo, useState } from "react";

import { formatBytes } from "../../utils/format/bytes.ts";
import Modal from "../common/Modal.tsx";

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (skipDuplicates: boolean) => void;
  totalFiles: number;
  alreadyUploaded: number;
  totalSize: number;
}

export default function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  totalFiles,
  alreadyUploaded,
  totalSize,
}: ConfirmModalProps) {
  const [forceReupload, setForceReupload] = useState(false);

  const filesToUpload = useMemo(
    () => (forceReupload ? totalFiles : totalFiles - alreadyUploaded),
    [forceReupload, totalFiles, alreadyUploaded],
  );

  function handleConfirm() {
    onConfirm(!forceReupload); // skipDuplicates = NOT forceReupload
    setForceReupload(false);
  }

  function handleClose() {
    setForceReupload(false);
    onClose();
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Confirm Upload"
      footer={
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={filesToUpload === 0}
            className="px-4 py-2 text-sm font-medium rounded transition-colors
              bg-nlr-blue text-white hover:bg-blue-700
              disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed"
          >
            Upload {filesToUpload.toLocaleString()} File{filesToUpload !== 1 ? "s" : ""}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 text-center">
          <div>
            <div className="text-2xl font-bold text-gray-900">
              {filesToUpload.toLocaleString()}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">Files to Upload</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-gray-900">
              {formatBytes(totalSize)}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">Total Size</div>
          </div>
        </div>

        {alreadyUploaded > 0 && (
          <>
            <div className="text-sm text-yellow-700 bg-yellow-50 border border-yellow-200 rounded p-2.5">
              {alreadyUploaded.toLocaleString()} file{alreadyUploaded !== 1 ? "s" : ""} already
              exist in S3 and will be skipped.
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={forceReupload}
                onChange={(e) => setForceReupload(e.target.checked)}
                className="rounded border-gray-300"
              />
              Force re-upload duplicates
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}
