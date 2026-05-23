/**
 * Confirmation modal shown when the user tries to cancel a folder scan.
 */

import Modal from "../common/Modal.tsx";
import { WarningIcon } from "../../utils/icons.tsx";

interface CancelScanModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  foldersScanned: number;
  filesFound: number;
}

export default function CancelScanModal({
  isOpen,
  onClose,
  onConfirm,
  foldersScanned,
  filesFound,
}: CancelScanModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Cancel Folder Scan?"
      footer={
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
          >
            Keep Scanning
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 text-sm font-medium rounded transition-colors bg-red-600 text-white hover:bg-red-700"
          >
            Cancel Scan
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
          <WarningIcon className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800">
            <p>
              Scanning has found <strong>{filesFound}</strong> file{filesFound !== 1 ? "s" : ""} in{" "}
              <strong>{foldersScanned}</strong> folder{foldersScanned !== 1 ? "s" : ""} so far.
            </p>
            <p className="mt-2 text-amber-700">
              Cancelling will stop the scan and you'll need to start over if you want to continue.
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
