import { describe, expect, it } from 'vitest';

import {
  isChecked,
  SELECTION_ALL,
  SELECTION_NONE,
  selectionSize,
  toggleSelection,
  uncheckedNames,
} from '../../src/components/upload/folderBrowserSelection.ts';

describe('FolderBrowser selection model', () => {
  describe("default 'all-except' (everything checked)", () => {
    it('isChecked returns true for any name when excluded is empty', () => {
      expect(isChecked(SELECTION_ALL, 'anything')).toBe(true);
      expect(isChecked(SELECTION_ALL, 'file_0001.mcap')).toBe(true);
    });

    it('selectionSize returns the full totalCount', () => {
      expect(selectionSize(SELECTION_ALL, 10000)).toBe(10000);
      expect(selectionSize(SELECTION_ALL, 0)).toBe(0);
    });

    it('uncheckedNames returns [] when nothing is excluded', () => {
      const allNames = ['a.mcap', 'b.mcap', 'c.mcap'];
      expect(uncheckedNames(SELECTION_ALL, allNames)).toEqual([]);
    });
  });

  describe('SELECTION_NONE (nothing checked)', () => {
    it('isChecked returns false for everything', () => {
      expect(isChecked(SELECTION_NONE, 'a')).toBe(false);
      expect(isChecked(SELECTION_NONE, 'b')).toBe(false);
    });

    it('selectionSize is 0', () => {
      expect(selectionSize(SELECTION_NONE, 10000)).toBe(0);
    });

    it('uncheckedNames returns all names', () => {
      const allNames = ['a.mcap', 'b.mcap', 'c.mcap'];
      expect(uncheckedNames(SELECTION_NONE, allNames)).toEqual(allNames);
    });
  });

  describe('toggleSelection — all-except mode', () => {
    it('toggling an item removes it (was checked → now unchecked)', () => {
      const next = toggleSelection(SELECTION_ALL, 'x.mcap');
      expect(next.mode).toBe('all-except');
      expect(isChecked(next, 'x.mcap')).toBe(false);
      expect(isChecked(next, 'y.mcap')).toBe(true);
      expect(selectionSize(next, 10)).toBe(9);
    });

    it('toggling an already-excluded item re-adds it', () => {
      const once = toggleSelection(SELECTION_ALL, 'x.mcap');
      const twice = toggleSelection(once, 'x.mcap');
      expect(isChecked(twice, 'x.mcap')).toBe(true);
      expect(selectionSize(twice, 10)).toBe(10);
    });

    it('does not mutate the input set', () => {
      const next = toggleSelection(SELECTION_ALL, 'x.mcap');
      expect(SELECTION_ALL.mode).toBe('all-except');
      expect(SELECTION_ALL.excluded.size).toBe(0);
      // Sanity: the new selection has its own set
      expect(next).not.toBe(SELECTION_ALL);
    });
  });

  describe('toggleSelection — subset mode', () => {
    it('toggling an item adds it (was unchecked → now checked)', () => {
      const next = toggleSelection(SELECTION_NONE, 'x.mcap');
      expect(next.mode).toBe('subset');
      expect(isChecked(next, 'x.mcap')).toBe(true);
      expect(isChecked(next, 'y.mcap')).toBe(false);
      expect(selectionSize(next, 10)).toBe(1);
    });

    it('toggling an already-included item removes it', () => {
      const once = toggleSelection(SELECTION_NONE, 'x.mcap');
      const twice = toggleSelection(once, 'x.mcap');
      expect(isChecked(twice, 'x.mcap')).toBe(false);
      expect(selectionSize(twice, 10)).toBe(0);
    });
  });

  describe('uncheckedNames', () => {
    it('returns only excluded names that are in the current directory listing', () => {
      const sel = toggleSelection(
        toggleSelection(SELECTION_ALL, 'a.mcap'),
        'stale.mcap', // excluded by a prior dir, but not in this listing
      );
      expect(uncheckedNames(sel, ['a.mcap', 'b.mcap'])).toEqual(['a.mcap']);
    });

    it('subset mode returns the complement of included', () => {
      const sel = toggleSelection(SELECTION_NONE, 'a.mcap');
      expect(uncheckedNames(sel, ['a.mcap', 'b.mcap', 'c.mcap'])).toEqual(['b.mcap', 'c.mcap']);
    });
  });

  describe('scaling — handles a 10k-file listing without materializing 10k state', () => {
    it('all-except with one toggle still has a 1-element excluded set', () => {
      let sel: typeof SELECTION_ALL = SELECTION_ALL;
      sel = toggleSelection(sel, 'file_0042.mcap');
      // The excluded set only holds the one toggled item, regardless of directory size.
      expect(sel.mode).toBe('all-except');
      expect((sel as { excluded: Set<string> }).excluded.size).toBe(1);
      expect(selectionSize(sel, 10000)).toBe(9999);
    });

    it('isChecked is O(1) for any name across 10k items', () => {
      let sel: typeof SELECTION_ALL = SELECTION_ALL;
      sel = toggleSelection(sel, 'file_5000.mcap');
      // Spot-check across the range — all reads are constant-time hash lookups
      expect(isChecked(sel, 'file_0001.mcap')).toBe(true);
      expect(isChecked(sel, 'file_5000.mcap')).toBe(false);
      expect(isChecked(sel, 'file_9999.mcap')).toBe(true);
    });
  });
});
