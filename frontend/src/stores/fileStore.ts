/**
 * FileStore — manages the Map<string, UnifiedFileRow> for the unified upload table.
 *
 * Exposes a useSyncExternalStore-compatible interface. Uses rAF batching
 * so that multiple SSE updates within a single frame coalesce into one
 * React re-render.
 *
 * Maintains a `sortedIndex` array updated in place on per-row mutations:
 * `updateFile` is O(1) regardless of how many rows are in the store. The
 * full O(n log n) sort only runs when the user explicitly clicks a sort
 * column header, or when files are added/removed in bulk (scan / mark).
 */

import type { FileUploadState, ScannedFolder } from '../types/api.ts';
import type {
  SortDir,
  SortKey,
  StatusFilter,
  UnifiedFileRow,
  UnifiedStatus,
} from '../types/upload.ts';

type Listener = () => void;

export class FileStore {
  private rows = new Map<string, UnifiedFileRow>();
  private listeners = new Set<Listener>();

  // `sortedIndex` is the canonical "in sort order" view of every row.
  // `pathToSortedIndex` gives O(1) slot lookup for updateFile.
  // `filteredIndex` is what getSnapshot returns — derived from sortedIndex
  // by applying the current filter + search.
  private sortedIndex: UnifiedFileRow[] = [];
  private pathToSortedIndex = new Map<string, number>();
  private filteredIndex: UnifiedFileRow[] = [];
  private sortedDirty = false;
  private filteredDirty = false;

  // Sort / filter state
  private sortKey: SortKey = 'filename';
  private sortDir: SortDir = 'asc';
  private filter: StatusFilter = 'all';
  private search = '';

  // Frozen flag: when true, setSort is a no-op (positions stay fixed during upload).
  // No separate frozen array — updateFile patches sortedIndex in place either way.
  private frozen = false;

  // rAF batching
  private rafId: number | null = null;

  // ── useSyncExternalStore interface ──

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): UnifiedFileRow[] => {
    if (this.sortedDirty) this.rebuildSortedIndex();
    if (this.filteredDirty) this.rebuildFilteredIndex();
    return this.filteredIndex;
  };

  // ── Public getters ──

  getRow(path: string): UnifiedFileRow | undefined {
    return this.rows.get(path);
  }

  getAllRows(): Map<string, UnifiedFileRow> {
    return this.rows;
  }

  getSortKey(): SortKey {
    return this.sortKey;
  }

  getSortDir(): SortDir {
    return this.sortDir;
  }

  getFilter(): StatusFilter {
    return this.filter;
  }

  getSearch(): string {
    return this.search;
  }

  getSize(): number {
    return this.rows.size;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  // ── Populate from scan ──

  buildFromScan(folders: ScannedFolder[]): void {
    this.rows.clear();
    for (const folder of folders) {
      this.addFolderInternal(folder);
    }
    this.markStructureDirty();
    this.notify();
  }

  addFolderFromScan(folder: ScannedFolder): void {
    this.addFolderInternal(folder);
    this.markStructureDirty();
    this.notify();
  }

  private addFolderInternal(folder: ScannedFolder): void {
    for (const file of folder.files) {
      if (this.rows.has(file.path)) continue;
      const uploaded = file.already_uploaded ?? false;
      this.rows.set(file.path, {
        path: file.path,
        filename: file.filename,
        size: file.size,
        folder: folder.relative_path === '.' ? '' : folder.relative_path,
        mtime: file.mtime,
        alreadyUploaded: uploaded,
        status: uploaded ? 'already_uploaded' : 'new',
        progressPercent: 0,
        s3Path: '',
        duration: null,
        speed: null,
        error: '',
        fileCategory: file.file_category ?? 'other',
      });
    }
  }

  // ── Per-file update (called from SSE callbacks) ──

  updateFile(path: string, update: Partial<UnifiedFileRow>): void {
    const existing = this.rows.get(path);
    if (!existing) return;

    // Shallow-clone so React.memo detects a new reference
    const updated = { ...existing, ...update };
    this.rows.set(path, updated);

    // O(1) in-place patch — positions never change on a content update.
    const idx = this.pathToSortedIndex.get(path);
    if (idx !== undefined) {
      this.sortedIndex[idx] = updated;
    }

    // The status field can flip filter membership; re-derive on the next snapshot.
    this.filteredDirty = true;
    this.scheduleNotify();
  }

  // ── Bulk merge from terminal UploadJob ──

  mergeCompletion(files: FileUploadState[]): void {
    for (const f of files) {
      const existing = this.rows.get(f.local_path);
      if (!existing) continue;

      const updated: UnifiedFileRow = {
        ...existing,
        status: mapApiStatus(f.status),
        progressPercent: f.progress_percent,
        s3Path: f.s3_path,
        duration: f.upload_duration_seconds,
        speed: f.upload_speed_mbps,
        error: f.error_message,
        fileCategory: f.file_category || existing.fileCategory,
      };
      this.rows.set(f.local_path, updated);
      const idx = this.pathToSortedIndex.get(f.local_path);
      if (idx !== undefined) {
        this.sortedIndex[idx] = updated;
      }
    }
    this.filteredDirty = true;
    this.notify();
  }

  // ── Transition: review → upload ──

  markSelectedAsPending(paths: Set<string>): void {
    // Remove unselected rows, keep only selected
    for (const [key] of this.rows) {
      if (!paths.has(key)) {
        this.rows.delete(key);
      }
    }
    // All remaining rows are "queued"
    for (const [key, row] of this.rows) {
      this.rows.set(key, { ...row, status: 'queued' });
    }
    this.markStructureDirty();
    this.notify();
  }

  // ── Freeze / unfreeze sort ──
  //
  // Frozen state means setSort is ignored — useful during upload so that
  // rows don't reshuffle under the user when their status changes. The
  // in-place updateFile already keeps positions stable; the only thing
  // freeze actually prevents is an explicit column-header click.

  freezeSort(): void {
    if (this.sortedDirty) this.rebuildSortedIndex();
    this.frozen = true;
    this.notify();
  }

  unfreezeSort(): void {
    this.frozen = false;
    this.notify();
  }

  // ── Sort / filter / search ──

  setSort(key: SortKey, dir?: SortDir): void {
    if (this.frozen) return;
    if (dir) {
      this.sortKey = key;
      this.sortDir = dir;
    } else if (this.sortKey === key) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortKey = key;
      this.sortDir = 'asc';
    }
    this.sortedDirty = true;
    this.filteredDirty = true;
    this.notify();
  }

  setFilter(filter: StatusFilter): void {
    this.filter = filter;
    this.filteredDirty = true;
    this.notify();
  }

  setSearch(query: string): void {
    this.search = query;
    this.filteredDirty = true;
    this.notify();
  }

  // ── Reset ──

  clear(): void {
    this.rows.clear();
    this.sortedIndex = [];
    this.pathToSortedIndex.clear();
    this.filteredIndex = [];
    this.sortedDirty = false;
    this.filteredDirty = false;
    this.frozen = false;
    this.sortKey = 'filename';
    this.sortDir = 'asc';
    this.filter = 'all';
    this.search = '';
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.notify();
  }

  // ── Internals ──

  /** Membership in rows changed (add/remove/bulk mark). Re-sort + re-filter. */
  private markStructureDirty(): void {
    this.sortedDirty = true;
    this.filteredDirty = true;
  }

  private rebuildSortedIndex(): void {
    const arr = Array.from(this.rows.values());
    const dir = this.sortDir === 'asc' ? 1 : -1;
    const key = this.sortKey;
    arr.sort((a, b) => {
      switch (key) {
        case 'filename':
          return dir * a.filename.localeCompare(b.filename);
        case 'folder':
          return dir * a.folder.localeCompare(b.folder);
        case 'size':
          return dir * (a.size - b.size);
        case 'mtime':
          return dir * (a.mtime - b.mtime);
        case 'status':
          return dir * (statusOrder(a.status) - statusOrder(b.status));
        default:
          return 0;
      }
    });
    this.sortedIndex = arr;
    this.pathToSortedIndex.clear();
    for (let i = 0; i < arr.length; i++) {
      this.pathToSortedIndex.set(arr[i]?.path, i);
    }
    this.sortedDirty = false;
  }

  private rebuildFilteredIndex(): void {
    let result: UnifiedFileRow[] = this.sortedIndex;

    if (this.filter !== 'all') {
      result = result.filter((r) => matchesFilter(r, this.filter));
    }

    if (this.search) {
      const q = this.search.toLowerCase();
      result = result.filter(
        (r) => r.filename.toLowerCase().includes(q) || r.folder.toLowerCase().includes(q),
      );
    }

    this.filteredIndex = result;
    this.filteredDirty = false;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private scheduleNotify(): void {
    if (this.rafId != null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.notify();
    });
  }
}

// ── Helpers ──

function mapApiStatus(status: string): UnifiedStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'skipped':
      return 'skipped';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'uploading':
    case 'analyzing':
      return 'in_progress';
    default:
      return 'queued';
  }
}

function matchesFilter(r: UnifiedFileRow, filter: StatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'new':
      return r.status === 'new' || !r.alreadyUploaded;
    case 'uploaded':
      return r.status === 'already_uploaded' || r.alreadyUploaded;
    case 'queued':
      return r.status === 'queued';
    case 'in_progress':
      return r.status === 'in_progress';
    case 'completed':
      return r.status === 'completed';
    case 'skipped':
      return r.status === 'skipped';
    case 'failed':
      return r.status === 'failed';
    default:
      return true;
  }
}

function statusOrder(status: UnifiedStatus): number {
  switch (status) {
    case 'new':
      return 0;
    case 'already_uploaded':
      return 1;
    case 'in_progress':
      return 2;
    case 'queued':
      return 3;
    case 'completed':
      return 4;
    case 'skipped':
      return 5;
    case 'failed':
      return 6;
    default:
      return 7;
  }
}

/** Singleton instance */
export const fileStore = new FileStore();
