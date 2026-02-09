/**
 * DOM manipulation helpers.
 */

/**
 * Set the text content of an element by ID.
 * @param {string} id
 * @param {string | number} value
 */
export function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

/**
 * Remove the `hidden` class from an element by ID.
 * @param {string} id
 */
export function showEl(id) {
  document.getElementById(id)?.classList.remove('hidden');
}

/**
 * Add the `hidden` class to an element by ID.
 * @param {string} id
 */
export function hideEl(id) {
  document.getElementById(id)?.classList.add('hidden');
}

/**
 * Disable a button, swap its label, run a callback, then restore.
 * @param {HTMLButtonElement | null} btn
 * @param {string} loadingText
 * @param {() => Promise<void>} callback
 */
/**
 * Toggle the `hidden` class on an element by ID.
 * @param {string} id
 * @param {boolean} show - When true, remove `hidden`; when false, add it.
 */
export function toggleEl(id, show) {
  document.getElementById(id)?.classList.toggle('hidden', !show);
}

/**
 * Append text to an element's textContent by ID.
 * @param {string} id
 * @param {string} value
 */
export function appendText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent += String(value);
}

/**
 * Disable a button, swap its label, run a callback, then restore.
 * @param {HTMLButtonElement | null} btn
 * @param {string} loadingText
 * @param {() => Promise<void>} callback
 */
export async function withLoadingButton(btn, loadingText, callback) {
  if (!btn) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = loadingText;
  try {
    await callback();
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
