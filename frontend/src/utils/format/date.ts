/**
 * Format a Unix timestamp (seconds) to a locale date string (date only).
 */
export function formatDate(mtime: number): string {
  return new Date(mtime * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Format a Unix timestamp (seconds) to a locale datetime string (date + time).
 * Returns "-" for null/undefined values.
 */
export function formatDateTime(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return "-";
  return new Date(epochSeconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
