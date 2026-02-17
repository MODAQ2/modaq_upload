/**
 * Format seconds into a human-readable ETA string.
 * Returns "--" for null/invalid values.
 */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return "--";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/**
 * Format a duration in seconds to "Xms", "Xs", "Xm Ys", or "Xh Ym".
 * Includes millisecond precision for durations less than 1 second.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return "--";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}
