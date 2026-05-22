/**
 * FileStore — verifies the sorted-index refactor:
 * - updateFile mutates in O(1) without re-sorting (positions stay stable)
 * - getSnapshot returns a stable view that respects filter + search
 * - freezeSort blocks setSort while still allowing in-place row updates
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { FileStore } from '../../src/stores/fileStore.ts';
import type { ScannedFolder } from '../../src/types/api.ts';

function makeScannedFolder(count: number, relativePath = 'data'): ScannedFolder {
  return {
    folder_path: `/root/${relativePath}`,
    relative_path: relativePath,
    files: Array.from({ length: count }, (_, i) => ({
      path: `/root/${relativePath}/file_${String(i).padStart(4, '0')}.mcap`,
      filename: `file_${String(i).padStart(4, '0')}.mcap`,
      size: 1000 + i,
      mtime: 1700000000 + i,
      already_uploaded: false,
    })),
    total_files: count,
    already_uploaded: 0,
    all_uploaded: false,
  };
}

describe('FileStore', () => {
  let store: FileStore;

  beforeEach(() => {
    store = new FileStore();
  });

  describe('buildFromScan / addFolderFromScan', () => {
    it('builds rows in sorted order on first snapshot', () => {
      store.buildFromScan([makeScannedFolder(5)]);
      const snap = store.getSnapshot();
      expect(snap).toHaveLength(5);
      expect(snap[0]?.filename).toBe('file_0000.mcap');
      expect(snap[4]?.filename).toBe('file_0004.mcap');
    });

    it('re-derives sort + filter when a new folder is added', () => {
      store.buildFromScan([makeScannedFolder(3, 'a')]);
      store.addFolderFromScan(makeScannedFolder(3, 'b'));
      const snap = store.getSnapshot();
      expect(snap).toHaveLength(6);
    });
  });

  describe('updateFile — O(1) in-place patch', () => {
    it('replaces the row in sortedIndex without reordering', () => {
      store.buildFromScan([makeScannedFolder(10)]);
      const before = store.getSnapshot();
      const target = before[3]!;
      store.updateFile(target.path, { status: 'in_progress', progressPercent: 42 });
      const after = store.getSnapshot();
      // Position unchanged
      expect(after[3]?.path).toBe(target.path);
      // Content updated
      expect(after[3]?.status).toBe('in_progress');
      expect(after[3]?.progressPercent).toBe(42);
      // Other rows untouched
      expect(after[0]?.status).toBe(before[0]?.status);
    });

    it('returns a new row reference (React.memo signal)', () => {
      store.buildFromScan([makeScannedFolder(3)]);
      const before = store.getSnapshot();
      const targetPath = before[1]?.path;
      const beforeRow = store.getRow(targetPath)!;
      store.updateFile(targetPath, { status: 'completed' });
      const afterRow = store.getRow(targetPath)!;
      expect(afterRow).not.toBe(beforeRow);
      expect(afterRow.status).toBe('completed');
    });

    it('is a no-op for an unknown path', () => {
      store.buildFromScan([makeScannedFolder(3)]);
      store.updateFile('/not/in/store.mcap', { status: 'completed' });
      const snap = store.getSnapshot();
      expect(snap).toHaveLength(3);
    });

    it('scales: 1000 updates only sort the array once (at build)', () => {
      store.buildFromScan([makeScannedFolder(1000)]);
      // Prime the snapshot (forces the one-and-only sort)
      store.getSnapshot();
      // Now mutate every row once
      for (const row of store.getAllRows().values()) {
        store.updateFile(row.path, { progressPercent: 50 });
      }
      const snap = store.getSnapshot();
      // Positions are stable — first/last filename match the original sort
      expect(snap[0]?.filename).toBe('file_0000.mcap');
      expect(snap[999]?.filename).toBe('file_0999.mcap');
      // Every row reflects the update
      expect(snap.every((r) => r.progressPercent === 50)).toBe(true);
    });
  });

  describe('filter + search', () => {
    it('filter narrows the snapshot without dropping rows from the store', () => {
      store.buildFromScan([makeScannedFolder(5)]);
      store.updateFile(store.getSnapshot()[2]?.path, { status: 'completed' });
      store.setFilter('completed');
      const snap = store.getSnapshot();
      expect(snap).toHaveLength(1);
      expect(store.getSize()).toBe(5);
    });

    it('search matches filename + folder substring', () => {
      store.buildFromScan([makeScannedFolder(2, 'alpha'), makeScannedFolder(2, 'beta')]);
      store.setSearch('alpha');
      const snap = store.getSnapshot();
      expect(snap.every((r) => r.folder === 'alpha')).toBe(true);
      expect(snap).toHaveLength(2);
    });
  });

  describe('freezeSort / unfreezeSort', () => {
    it('freezeSort makes setSort a no-op', () => {
      store.buildFromScan([makeScannedFolder(5)]);
      store.setSort('size', 'desc');
      const beforeFreeze = store.getSnapshot();
      store.freezeSort();
      expect(store.isFrozen()).toBe(true);
      store.setSort('filename', 'asc'); // ignored
      const afterFreeze = store.getSnapshot();
      expect(afterFreeze[0]?.path).toBe(beforeFreeze[0]?.path);
      expect(store.getSortKey()).toBe('size');
      expect(store.getSortDir()).toBe('desc');
    });

    it('updateFile still patches rows while frozen', () => {
      store.buildFromScan([makeScannedFolder(5)]);
      store.freezeSort();
      const path = store.getSnapshot()[0]?.path;
      store.updateFile(path, { status: 'in_progress' });
      expect(store.getRow(path)?.status).toBe('in_progress');
    });

    it('unfreezeSort restores the ability to reorder', () => {
      store.buildFromScan([makeScannedFolder(5)]);
      store.freezeSort();
      store.unfreezeSort();
      expect(store.isFrozen()).toBe(false);
      store.setSort('size', 'desc');
      const snap = store.getSnapshot();
      expect(snap[0]?.size).toBeGreaterThan(snap[snap.length - 1]?.size ?? 0);
    });
  });

  describe('markSelectedAsPending', () => {
    it('drops unselected rows and queues the rest', () => {
      store.buildFromScan([makeScannedFolder(5)]);
      const allPaths = store.getSnapshot().map((r) => r.path);
      const selected = new Set(allPaths.slice(0, 3));
      store.markSelectedAsPending(selected);
      const snap = store.getSnapshot();
      expect(snap).toHaveLength(3);
      expect(snap.every((r) => r.status === 'queued')).toBe(true);
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      store.buildFromScan([makeScannedFolder(5)]);
      store.setSort('size', 'desc');
      store.setFilter('completed');
      store.freezeSort();
      store.clear();
      expect(store.getSize()).toBe(0);
      expect(store.getSnapshot()).toEqual([]);
      expect(store.isFrozen()).toBe(false);
      expect(store.getSortKey()).toBe('filename');
      expect(store.getFilter()).toBe('all');
    });
  });
});
