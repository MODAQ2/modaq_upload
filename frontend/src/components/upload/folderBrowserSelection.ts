/**
 * Selection model for FolderBrowser.
 *
 * Stored as a discriminated union so loading a directory with thousands of
 * items never materializes an N-sized Set in React state. "all-except" with an
 * empty excluded set is the natural "everything checked by default" — O(1).
 */

export type Selection =
  | { mode: 'all-except'; excluded: Set<string> }
  | { mode: 'subset'; included: Set<string> };

export const SELECTION_ALL: Selection = { mode: 'all-except', excluded: new Set() };
export const SELECTION_NONE: Selection = { mode: 'subset', included: new Set() };

export function isChecked(sel: Selection, name: string): boolean {
  return sel.mode === 'all-except' ? !sel.excluded.has(name) : sel.included.has(name);
}

export function selectionSize(sel: Selection, totalCount: number): number {
  return sel.mode === 'all-except' ? totalCount - sel.excluded.size : sel.included.size;
}

export function toggleSelection(sel: Selection, name: string): Selection {
  if (sel.mode === 'all-except') {
    const next = new Set(sel.excluded);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return { mode: 'all-except', excluded: next };
  }
  const next = new Set(sel.included);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return { mode: 'subset', included: next };
}

/** Names that are NOT checked. O(excluded.size) in "all-except"; O(N) in "subset". */
export function uncheckedNames(sel: Selection, allNames: readonly string[]): string[] {
  if (sel.mode === 'all-except') {
    return [...sel.excluded].filter((n) => allNames.includes(n));
  }
  return allNames.filter((n) => !sel.included.has(n));
}
