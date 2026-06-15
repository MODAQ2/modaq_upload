/** Pure helpers for resolving an S3 destination prefix from S3FolderPicker state. */

export type DestMode = 'existing' | 'new';

/** Trim, drop surrounding slashes, and collapse internal whitespace runs. */
export function sanitizeFolderName(name: string): string {
  return name
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Resolve the destination prefix from the current browse location and form state.
 * Returns '' when the destination is not a valid folder (e.g. bucket root, or an
 * empty new-subfolder name).
 */
export function resolveDestination(prefix: string, mode: DestMode, newName: string): string {
  const base = prefix.replace(/\/$/, '');
  if (mode === 'existing') {
    return base; // '' at bucket root → invalid
  }
  const clean = sanitizeFolderName(newName);
  if (!clean) return '';
  return base ? `${base}/${clean}` : clean;
}
