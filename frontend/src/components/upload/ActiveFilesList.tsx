/**
 * Compact list showing only files currently being uploaded.
 *
 * Displays up to 8 active files with:
 * - Filename
 * - File size
 * - Upload progress bar
 * - Status indicator
 *
 * Used during upload phase to show real-time activity without
 * overwhelming the UI with thousands of rows.
 */

import type { FileUploadState } from '../../types/api.ts';
import { formatBytes } from '../../utils/format/bytes.ts';
import { CheckIcon, WarningIcon, XIcon } from '../../utils/icons.tsx';
import ProgressBar from '../common/ProgressBar.tsx';
import Spinner from '../common/Spinner.tsx';

interface ActiveFilesListProps {
  /** Currently active files (max 8) */
  files: FileUploadState[];
}

export default function ActiveFilesList({ files }: ActiveFilesListProps) {
  if (files.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
        <p className="text-gray-500 text-sm">No files currently uploading</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Currently Uploading</h3>
        <span className="text-xs text-gray-500">{files.length} active</span>
      </div>

      <div className="space-y-2">
        {files.map((file) => (
          <ActiveFileCard key={file.local_path} file={file} />
        ))}
      </div>
    </div>
  );
}

function ActiveFileCard({ file }: { file: FileUploadState }) {
  const statusIcon = getStatusIcon(file.status);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-gray-900 truncate">{file.filename}</p>
            {statusIcon}
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {formatBytes(file.file_size)}
            {file.status === 'uploading' && file.bytes_uploaded > 0 && (
              <span className="ml-2">{formatBytes(file.bytes_uploaded)} uploaded</span>
            )}
          </p>
        </div>
      </div>

      {/* Progress bar for uploading files */}
      {file.status === 'uploading' && (
        <div className="mt-2">
          <ProgressBar percent={file.progress_percent} color="bg-nlr-blue" />
        </div>
      )}

      {/* Error message for failed files */}
      {file.status === 'failed' && file.error_message && (
        <div className="mt-2 text-xs text-red-600 bg-red-50 rounded px-2 py-1">
          {file.error_message}
        </div>
      )}
    </div>
  );
}

function getStatusIcon(status: string) {
  switch (status) {
    case 'uploading':
      return <Spinner size="sm" />;
    case 'completed':
      return <CheckIcon className="w-4 h-4 text-green-600 flex-shrink-0" />;
    case 'failed':
      return <XIcon className="w-4 h-4 text-red-600 flex-shrink-0" />;
    case 'skipped':
      return <WarningIcon className="w-4 h-4 text-yellow-600 flex-shrink-0" />;
    case 'analyzing':
      return <Spinner size="sm" />;
    default:
      return null;
  }
}
