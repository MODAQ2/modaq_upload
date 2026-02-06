/**
 * File extraction from drag-and-drop and file input.
 */

/**
 * Recursively read all files from a FileSystemDirectoryHandle.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} [path]
 * @returns {Promise<File[]>}
 */
export async function readDirectoryRecursively(dirHandle, path = '') {
  const files = [];

  // @ts-ignore — FileSystemDirectoryHandle async iteration not in all TS DOM libs
  for await (const [name, handle] of dirHandle) {
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      file.relativePath = path + name;
      files.push(file);
    } else if (handle.kind === 'directory') {
      const subFiles = await readDirectoryRecursively(handle, `${path}${name}/`);
      files.push(...subFiles);
    }
  }

  return files;
}

/**
 * Extract all files from dropped items, recursively scanning folders.
 * @param {DataTransferItemList} items
 * @returns {Promise<File[]>}
 */
export async function extractFilesFromDrop(items) {
  const files = [];
  const entries = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file') {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        entries.push(entry);
      } else {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  }

  for (const entry of entries) {
    const entryFiles = await readEntryRecursively(entry);
    files.push(...entryFiles);
  }

  return files;
}

/**
 * Recursively read a FileSystemEntry (file or directory).
 * @param {FileSystemEntry} entry
 * @returns {Promise<File[]>}
 */
async function readEntryRecursively(entry) {
  if (entry.isFile) {
    return new Promise((resolve) => {
      /** @type {FileSystemFileEntry} */ (entry).file(
        (file) => resolve([file]),
        () => resolve([]),
      );
    });
  }

  if (entry.isDirectory) {
    const files = [];
    const reader = /** @type {FileSystemDirectoryEntry} */ (entry).createReader();

    const readAllEntries = async () => {
      const allEntries = [];
      const readBatch = () =>
        new Promise((resolve) => {
          reader.readEntries(
            (batch) => resolve(batch),
            () => resolve([]),
          );
        });

      let batch;
      do {
        batch = await readBatch();
        allEntries.push(...batch);
      } while (batch.length > 0);

      return allEntries;
    };

    const childEntries = await readAllEntries();
    for (const child of childEntries) {
      const childFiles = await readEntryRecursively(child);
      files.push(...childFiles);
    }
    return files;
  }

  return [];
}
