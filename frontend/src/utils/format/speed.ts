/**
 * Format a speed in Mbps.
 */
export function formatSpeed(mbps: number | null): string {
  if (mbps == null) return "--";
  return `${mbps.toFixed(2)} Mbps`;
}
