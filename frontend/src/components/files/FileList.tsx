import type { S3File, S3Folder } from "../../types/api.ts";
import { FolderIcon, FileIcon } from "../../utils/icons.tsx";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface FileListProps {
  folders: S3Folder[];
  files: S3File[];
  onNavigate: (prefix: string) => void;
}

export default function FileList({ folders, files, onNavigate }: FileListProps) {
  if (folders.length === 0 && files.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <FolderIcon className="mx-auto h-12 w-12 text-gray-300 mb-3" />
        <p className="text-sm">No files or folders found at this location.</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-100">
      {folders.map((folder) => (
        <button
          key={folder.prefix}
          onClick={() => onNavigate(folder.prefix)}
          className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 text-left transition-colors"
        >
          <FolderIcon className="h-5 w-5 text-nlr-yellow" />
          <span className="text-sm font-medium text-gray-900">{folder.name}</span>
        </button>
      ))}

      {files.map((file) => (
        <div
          key={file.key}
          className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
        >
          <FileIcon className="h-5 w-5 text-gray-400" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate" title={file.name}>
              {file.name}
            </p>
          </div>
          <span className="text-xs text-gray-500 whitespace-nowrap">{formatBytes(file.size)}</span>
          <span className="text-xs text-gray-400 whitespace-nowrap">
            {formatDate(file.last_modified)}
          </span>
        </div>
      ))}
    </div>
  );
}
