/**
 * Confirmation modal shown when the user clicks "Cancel Upload".
 */

import Modal from "../common/Modal.tsx";
import { WarningIcon } from "../../utils/icons.tsx";

interface CancelConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  filesProcessed: number;
  totalFiles: number;
}

export default function CancelConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  filesProcessed,
  totalFiles,
}: CancelConfirmModalProps) {
  const remaining = totalFiles - filesProcessed;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Cancel Upload?"
      footer={
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
          >
            Keep Uploading
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 text-sm font-medium rounded transition-colors bg-red-600 text-white hover:bg-red-700"
          >
            Cancel Upload
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
          <WarningIcon className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800">
            <p>
              <strong>{filesProcessed}</strong> of <strong>{totalFiles}</strong> files
              have been processed so far. Cancelling will stop the remaining{" "}
              <strong>{remaining}</strong> file{remaining !== 1 ? "s" : ""} from being uploaded.
            </p>
            <p className="mt-2 text-amber-700">
              Files already uploaded will remain in cloud storage.
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
