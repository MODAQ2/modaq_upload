/** CSV export utility for the upload summary. */

import type { UnifiedFileRow } from "../types/upload.ts";

/**
 * Generate and download a CSV file from the unified file rows.
 */
export function downloadUploadCsv(files: UnifiedFileRow[], jobId: string): void {
  const header = "Filename,Folder,Size,Status,S3 Path,Duration (s),Speed (Mbps),Error\n";
  const rows = files
    .map((f) => {
      const cols = [
        csvEscape(f.filename),
        csvEscape(f.folder),
        f.size.toString(),
        f.status,
        csvEscape(f.s3Path),
        f.duration?.toFixed(2) ?? "",
        f.speed?.toFixed(2) ?? "",
        csvEscape(f.error),
      ];
      return cols.join(",");
    })
    .join("\n");

  const blob = new Blob([header + rows], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `upload-summary-${jobId.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
