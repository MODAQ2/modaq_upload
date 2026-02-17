/**
 * Thin hook wrapper around the FileStore singleton.
 *
 * Uses useSyncExternalStore so React re-renders only when the
 * store's snapshot reference changes (rAF-batched).
 */

import { useSyncExternalStore } from "react";

import { fileStore } from "../stores/fileStore.ts";
import type { UnifiedFileRow } from "../types/upload.ts";

export function useFileStore(): {
  files: UnifiedFileRow[];
  store: typeof fileStore;
} {
  const files = useSyncExternalStore(fileStore.subscribe, fileStore.getSnapshot);
  return { files, store: fileStore };
}
