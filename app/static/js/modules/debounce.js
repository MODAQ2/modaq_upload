/**
 * Debounce utility.
 */

/**
 * @param {(...args: any[]) => void} fn
 * @param {number} delay
 * @returns {(...args: any[]) => void}
 */
export function debounce(fn, delay) {
  let timeout = 0;
  return (/** @type {any[]} */ ...args) => {
    clearTimeout(timeout);
    timeout = window.setTimeout(() => fn(...args), delay);
  };
}
