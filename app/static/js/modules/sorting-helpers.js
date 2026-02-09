/**
 * Table sorting helpers: toggle column direction and update header indicators.
 */

/**
 * Toggle sort direction on a column config object.
 * @param {{ column: string, ascending: boolean }} config
 * @param {string} column
 */
export function toggleSort(config, column) {
  if (config.column === column) {
    config.ascending = !config.ascending;
  } else {
    config.column = column;
    config.ascending = true;
  }
}

/**
 * Update sort indicator arrows in table headers.
 * @param {string} headerSelector  - e.g. `'[data-sort]'`
 * @param {string} indicatorSelector - e.g. `'.sort-indicator'`
 * @param {string} dataKey - dataset key, e.g. `'sort'` or `'fileSort'`
 * @param {string} currentColumn
 * @param {boolean} ascending
 */
export function updateSortIndicators(
  headerSelector,
  indicatorSelector,
  dataKey,
  currentColumn,
  ascending,
) {
  for (const th of document.querySelectorAll(headerSelector)) {
    const indicator = th.querySelector(indicatorSelector);
    if (!indicator) continue;
    const col = /** @type {HTMLElement} */ (th).dataset[dataKey];
    indicator.textContent = col === currentColumn ? (ascending ? ' \u25B2' : ' \u25BC') : '';
  }
}
