/**
 * Modal shown when a scan finds 500+ files, suggesting the Large Folder Upload page.
 */

import { useNavigate } from 'react-router-dom';
import Modal from '../common/Modal.tsx';

const LARGE_FOLDER_THRESHOLD = 500;

interface LargeFolderSuggestionModalProps {
  isOpen: boolean;
  fileCount: number;
  onContinueAnyway: () => void;
}

export { LARGE_FOLDER_THRESHOLD };

export default function LargeFolderSuggestionModal({
  isOpen,
  fileCount,
  onContinueAnyway,
}: LargeFolderSuggestionModalProps) {
  const navigate = useNavigate();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onContinueAnyway}
      title="Large Folder Detected"
      footer={
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onContinueAnyway}
            className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
          >
            Continue Anyway
          </button>
          <button
            type="button"
            onClick={() => navigate('/large-folder-upload')}
            className="px-4 py-2 text-sm font-medium text-white bg-nlr-blue rounded hover:bg-blue-700"
          >
            Use Large Folder Upload
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-gray-700">
        <p>
          This folder contains{' '}
          <span className="font-semibold text-nlr-text">{fileCount.toLocaleString()} files</span>,
          which is a very large upload.
        </p>
        <p>
          The standard upload analyzes every file individually (checking timestamps, detecting
          duplicates). For this many files that process can be slow.
        </p>
        <p>
          <span className="font-semibold text-nlr-text">Large Folder Upload</span> uses{' '}
          <code className="font-mono bg-gray-100 px-1 rounded">aws s3 sync</code> to mirror the
          entire folder directly — much faster for large datasets, with real-time console output and
          the ability to cancel at any time.
        </p>
        <p className="text-gray-500 text-xs">
          Note: Large Folder Upload preserves your folder structure as-is rather than applying Hive
          partitioning.
        </p>
      </div>
    </Modal>
  );
}
