/**
 * FileStore — manages the Map<string, UnifiedFileRow> for the unified upload table.
 *
 * Exposes a useSyncExternalStore-compatible interface. Uses rAF batching
 * so that multiple SSE updates within a single frame coalesce into one
 * React re-render.
 */

import type { FileUploadState, ScannedFolder } from "../types/api.ts";
import type {
  SortDir,
  SortKey,
  StatusFilter,
  UnifiedFileRow,
  UnifiedStatus,
} from "../types/upload.ts";

type Listener = () => void;

export class FileStore {
  private rows = new Map<string, UnifiedFileRow>();
  private listeners = new Set<Listener>();
  private snapshot: UnifiedFileRow[] = [];
  private dirty = true;

  // Sort / filter state
  private sortKey: SortKey = "filename";
  private sortDir: SortDir = "asc";
  private filter: StatusFilter = "all";
  private search = "";

  // Frozen sort — during upload, positions stay fixed
  private frozen = false;
  private frozenArray: UnifiedFileRow[] = [];

  // rAF batching
  private rafId: number | null = null;

  // ── useSyncExternalStore interface ──

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): UnifiedFileRow[] => {
    if (this.dirty) {
      this.snapshot = this.buildSnapshot();
      this.dirty = false;
    }
    return this.snapshot;
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
    this.invalidate();
    this.notify();
  }

  addFolderFromScan(folder: ScannedFolder): void {
    this.addFolderInternal(folder);
    this.invalidate();
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
        folder: folder.relative_path === "." ? "" : folder.relative_path,
        mtime: file.mtime,
        alreadyUploaded: uploaded,
        status: uploaded ? "already_uploaded" : "new",
        progressPercent: 0,
        s3Path: "",
        duration: null,
        speed: null,
        error: "",
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

    // If frozen, update the frozen array in-place at O(1)
    if (this.frozen && updated._frozenIndex != null) {
      this.frozenArray[updated._frozenIndex] = updated;
    }

    this.invalidate();
    this.scheduleNotify();
  }

  // ── Bulk merge from terminal UploadJob ──

  mergeCompletion(files: FileUploadState[]): void {
    for (const f of files) {
      const existing = this.rows.get(f.local_path);
      if (!existing) continue;

      this.rows.set(f.local_path, {
        ...existing,
        status: mapApiStatus(f.status),
        progressPercent: f.progress_percent,
        s3Path: f.s3_path,
        duration: f.upload_duration_seconds,
        speed: f.upload_speed_mbps,
        error: f.error_message,
      });
    }
    this.invalidate();
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
      this.rows.set(key, { ...row, status: "queued" });
    }
    this.invalidate();
    this.notify();
  }

  // ── Freeze / unfreeze sort ──

  freezeSort(): void {
    // Build the frozen array from the current snapshot and stamp indices
    const current = this.buildSnapshot();
    this.frozenArray = [...current];
    for (let i = 0; i < this.frozenArray.length; i++) {
      const row = this.frozenArray[i]!;
      const updated = { ...row, _frozenIndex: i };
      this.frozenArray[i] = updated;
      this.rows.set(row.path, updated);
    }
    this.frozen = true;
    this.invalidate();
    this.notify();
  }

  unfreezeSort(): void {
    this.frozen = false;
    this.frozenArray = [];
    // Clear frozen indices
    for (const [key, row] of this.rows) {
      if (row._frozenIndex != null) {
        this.rows.set(key, { ...row, _frozenIndex: undefined });
      }
    }
    this.invalidate();
    this.notify();
  }

  // ── Sort / filter / search ──

  setSort(key: SortKey, dir?: SortDir): void {
    if (dir) {
      this.sortKey = key;
      this.sortDir = dir;
    } else if (this.sortKey === key) {
      this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
    } else {
      this.sortKey = key;
      this.sortDir = "asc";
    }
    // Re-freeze with new sort if frozen
    if (this.frozen) {
      this.frozen = false; // temporarily unfreeze to rebuild
      this.freezeSort();
      return;
    }
    this.invalidate();
    this.notify();
  }

  setFilter(filter: StatusFilter): void {
    this.filter = filter;
    this.invalidate();
    this.notify();
  }

  setSearch(query: string): void {
    this.search = query;
    this.invalidate();
    this.notify();
  }

  // ── Reset ──

  clear(): void {
    this.rows.clear();
    this.snapshot = [];
    this.dirty = false;
    this.frozen = false;
    this.frozenArray = [];
    this.sortKey = "filename";
    this.sortDir = "asc";
    this.filter = "all";
    this.search = "";
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.notify();
  }

  // ── Internals ──

  private buildSnapshot(): UnifiedFileRow[] {
    const source = this.frozen ? this.frozenArray : Array.from(this.rows.values());
    let result = source;

    // Filter
    result = this.applyFilter(result);

    // Search
    if (this.search) {
      const q = this.search.toLowerCase();
      result = result.filter(
        (r) =>
          r.filename.toLowerCase().includes(q) ||
          r.folder.toLowerCase().includes(q),
      );
    }

    // Sort (skip if frozen — positions are fixed)
    if (!this.frozen) {
      result = this.applySort(result);
    }

    return result;
  }

  private applyFilter(rows: UnifiedFileRow[]): UnifiedFileRow[] {
    switch (this.filter) {
      case "all":
        return rows;
      case "new":
        return rows.filter((r) => r.status === "new" || !r.alreadyUploaded);
      case "uploaded":
        return rows.filter((r) => r.status === "already_uploaded" || r.alreadyUploaded);
      case "queued":
        return rows.filter((r) => r.status === "queued");
      case "in_progress":
        return rows.filter((r) => r.status === "in_progress");
      case "completed":
        return rows.filter((r) => r.status === "completed");
      case "skipped":
        return rows.filter((r) => r.status === "skipped");
      case "failed":
        return rows.filter((r) => r.status === "failed");
      default:
        return rows;
    }
  }

  private applySort(rows: UnifiedFileRow[]): UnifiedFileRow[] {
    const dir = this.sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      switch (this.sortKey) {
        case "filename":
          return dir * a.filename.localeCompare(b.filename);
        case "folder":
          return dir * a.folder.localeCompare(b.folder);
        case "size":
          return dir * (a.size - b.size);
        case "mtime":
          return dir * (a.mtime - b.mtime);
        case "status": {
          return dir * (statusOrder(a.status) - statusOrder(b.status));
        }
        default:
          return 0;
      }
    });
  }

  private invalidate(): void {
    this.dirty = true;
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
    case "completed":
      return "completed";
    case "skipped":
      return "skipped";
    case "failed":
    case "cancelled":
      return "failed";
    case "uploading":
    case "analyzing":
      return "in_progress";
    default:
      return "queued";
  }
}

function statusOrder(status: UnifiedStatus): number {
  switch (status) {
    case "new":
      return 0;
    case "already_uploaded":
      return 1;
    case "in_progress":
      return 2;
    case "queued":
      return 3;
    case "completed":
      return 4;
    case "skipped":
      return 5;
    case "failed":
      return 6;
    default:
      return 7;
  }
}

/** Singleton instance */
export const fileStore = new FileStore();
