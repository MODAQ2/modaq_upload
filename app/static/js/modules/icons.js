/**
 * Reusable SVG icon templates.
 */

const FILE_ICON_PATH =
  'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z';

const FOLDER_ICON_PATH = 'M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z';

/**
 * File document SVG icon.
 * @param {string} [cls] - CSS classes (default: 'h-5 w-5 text-gray-400 mr-3')
 * @returns {string}
 */
export function fileIcon(cls = 'h-5 w-5 text-gray-400 mr-3') {
  return `<svg class="${cls}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${FILE_ICON_PATH}" /></svg>`;
}

/**
 * Folder SVG icon.
 * @param {string} [cls] - CSS classes (default: 'h-5 w-5 text-nlr-yellow mr-3')
 * @returns {string}
 */
export function folderIcon(cls = 'h-5 w-5 text-nlr-yellow mr-3') {
  return `<svg class="${cls}" fill="currentColor" viewBox="0 0 20 20"><path d="${FOLDER_ICON_PATH}" /></svg>`;
}
