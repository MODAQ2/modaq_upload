/**
 * Logs viewer page module.
 *
 * Loads log entries from /api/logs/entries with filtering, pagination,
 * expandable detail rows, and S3 sync trigger.
 */
import { apiGet, apiPost } from './api.js';
import { debounce } from './debounce.js';
import { hideEl, setText, toggleEl, withLoadingButton } from './dom.js';
import { showNotification } from './notify.js';
import state from './state.js';

/**
 * Format an ISO timestamp for display.
 * @param {string} iso
 * @returns {string}
 */
function formatTimestamp(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Return Tailwind classes for a log level badge.
 * @param {string} level
 * @returns {string}
 */
function levelBadgeClass(level) {
  const upper = level.toUpperCase();
  if (upper === 'ERROR') return 'bg-red-100 text-red-800';
  if (upper === 'WARNING') return 'bg-yellow-100 text-yellow-800';
  return 'bg-blue-100 text-blue-800';
}

/**
 * Get the filter DOM elements (shared by clearFilters and applyFilters).
 */
function getFilterEls() {
  return {
    date: /** @type {HTMLInputElement | null} */ (document.getElementById('filter-date')),
    level: /** @type {HTMLSelectElement | null} */ (document.getElementById('filter-level')),
    category: /** @type {HTMLSelectElement | null} */ (document.getElementById('filter-category')),
    search: /** @type {HTMLInputElement | null} */ (document.getElementById('filter-search')),
  };
}

/**
 * Render the log table body from an array of entries.
 * @param {Array<Record<string, unknown>>} entries
 */
function renderLogTable(entries) {
  const tbody = document.getElementById('log-table-body');
  if (!tbody) return;

  if (entries.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="px-4 py-8 text-center text-gray-500">No log entries found</td></tr>';
    return;
  }

  let html = '';
  for (const entry of entries) {
    const ts = formatTimestamp(/** @type {string} */ (entry.timestamp) || '');
    const level = /** @type {string} */ (entry.level) || 'INFO';
    const category = /** @type {string} */ (entry.category) || '';
    const event = /** @type {string} */ (entry.event) || '';
    const message = /** @type {string} */ (entry.message) || '';
    const metadata = /** @type {Record<string, unknown> | undefined} */ (entry.metadata);
    const hasMetadata = metadata && Object.keys(metadata).length > 0;

    const rowClass = hasMetadata ? 'cursor-pointer hover:bg-gray-50' : '';
    const toggleAttr = hasMetadata ? 'data-log-toggle' : '';

    html += `<tr class="${rowClass}" ${toggleAttr}>
      <td class="px-4 py-2 text-xs text-gray-600 font-mono whitespace-nowrap">${ts}</td>
      <td class="px-4 py-2"><span class="px-2 py-0.5 text-xs font-semibold rounded ${levelBadgeClass(level)}">${level}</span></td>
      <td class="px-4 py-2"><span class="px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-700">${category}</span></td>
      <td class="px-4 py-2 text-xs text-gray-700 font-mono">${event}</td>
      <td class="px-4 py-2 text-sm text-gray-800 truncate max-w-xs" title="${message.replace(/"/g, '&quot;')}">${message}</td>
    </tr>`;

    if (hasMetadata) {
      const metaRows = Object.entries(metadata)
        .map(
          ([k, v]) =>
            `<tr><td class="pr-4 text-gray-500 font-mono text-right align-top">${k}</td><td class="text-gray-800 break-all">${typeof v === 'object' ? JSON.stringify(v) : String(v)}</td></tr>`,
        )
        .join('');

      html += `<tr class="hidden log-detail-row">
        <td colspan="5" class="px-4 py-3 bg-gray-50">
          <table class="text-xs"><tbody>${metaRows}</tbody></table>
        </td>
      </tr>`;
    }
  }

  tbody.innerHTML = html;

  // Wire toggle for expandable rows
  for (const row of tbody.querySelectorAll('[data-log-toggle]')) {
    row.addEventListener('click', () => {
      const detail = row.nextElementSibling;
      if (detail?.classList.contains('log-detail-row')) {
        detail.classList.toggle('hidden');
      }
    });
  }
}

/** Fetch and render log entries using current filters + pagination. */
export async function loadLogEntries() {
  const params = new URLSearchParams();
  const { logFilters, logPagination } = state;

  if (logFilters.date) params.set('date', logFilters.date);
  if (logFilters.level) params.set('level', logFilters.level);
  if (logFilters.category) params.set('category', logFilters.category);
  if (logFilters.search) params.set('search', logFilters.search);
  params.set('offset', String(logPagination.offset));
  params.set('limit', String(logPagination.limit));

  try {
    const data = await apiGet(`/api/logs/entries?${params}`);

    renderLogTable(data.entries || []);

    // Update count label
    const total = data.total || 0;
    const from = total > 0 ? data.offset + 1 : 0;
    const to = Math.min(data.offset + data.limit, total);
    setText('log-count-label', `Showing ${from}-${to} of ${total}`);

    // Pagination buttons
    const prevBtn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('prev-page-btn')
    );
    const nextBtn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('next-page-btn')
    );
    if (prevBtn) prevBtn.disabled = data.offset <= 0;
    if (nextBtn) nextBtn.disabled = data.offset + data.limit >= total;
  } catch {
    setText('log-count-label', 'Failed to load log entries');
  }
}

/** Fetch and render log stats into the stat cards. */
export async function loadLogStats() {
  try {
    const data = await apiGet('/api/logs/stats');

    setText('stat-total', data.total_entries ?? 0);
    setText('stat-today', data.today_entries ?? 0);
    setText('stat-errors', data.level_counts?.ERROR ?? 0);
    setText('stat-files', data.file_count ?? 0);
  } catch {
    // Silently fail — stats are non-critical
  }
}

/** POST /api/logs/sync and show notification. */
export async function syncLogs() {
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('sync-logs-btn'));

  await withLoadingButton(btn, 'Syncing...', async () => {
    try {
      const data = await apiPost('/api/logs/sync');

      if (data.success) {
        showNotification(`Synced ${data.synced} log files to S3`, 'success');
      } else {
        showNotification(`Sync failed: ${data.error || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showNotification(`Sync error: ${err}`, 'error');
    }
  });
}

/** Track which CSV is currently previewed (to toggle on re-click). */
let currentPreviewPath = '';

/**
 * Extract time (HH:MM:SS) from a CSV filename like upload-summary-143022-abcd1234.csv.
 * @param {string} filename
 * @returns {string}
 */
function extractTimeFromFilename(filename) {
  const match = filename.match(/upload-summary-(\d{2})(\d{2})(\d{2})/);
  if (match) return `${match[1]}:${match[2]}:${match[3]}`;
  return '-';
}

/** Fetch CSV file list and render the Upload Summaries table. */
export async function loadCsvFiles() {
  try {
    const data = await apiGet('/api/logs/files');
    /** @type {Array<{date: string|null, filename: string, relative_path: string, size_bytes: number, type: string}>} */
    const csvFiles = (data.files || []).filter(
      (/** @type {{type: string}} */ f) => f.type === 'csv',
    );

    // Update badge
    setText('csv-count-badge', csvFiles.length);
    toggleEl('csv-count-badge', csvFiles.length > 0);

    const tbody = document.getElementById('csv-table-body');
    if (!tbody) return;

    if (csvFiles.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="4" class="px-4 py-6 text-center text-gray-500 text-sm">No upload summaries found</td></tr>';
      return;
    }

    let html = '';
    for (const file of csvFiles) {
      const date = file.date || '-';
      const time = extractTimeFromFilename(file.filename);
      const escapedPath = file.relative_path.replace(/"/g, '&quot;');

      html += `<tr>
        <td class="px-4 py-3 text-sm text-gray-700">${date}</td>
        <td class="px-4 py-3 text-sm text-gray-700 font-mono">${time}</td>
        <td class="px-4 py-3 text-sm text-gray-900 truncate" title="${file.filename}">${file.filename}</td>
        <td class="px-4 py-3 text-right whitespace-nowrap">
          <button class="csv-download-btn text-sm text-nlr-blue hover:underline mr-3" data-path="${escapedPath}">Download</button>
          <button class="csv-view-btn text-sm text-nlr-blue hover:underline" data-path="${escapedPath}">View</button>
        </td>
      </tr>`;
    }
    tbody.innerHTML = html;

    // Wire download buttons
    for (const btn of tbody.querySelectorAll('.csv-download-btn')) {
      btn.addEventListener('click', () => {
        const path = /** @type {HTMLElement} */ (btn).dataset.path || '';
        downloadCsv(path);
      });
    }

    // Wire view buttons
    for (const btn of tbody.querySelectorAll('.csv-view-btn')) {
      btn.addEventListener('click', () => {
        const path = /** @type {HTMLElement} */ (btn).dataset.path || '';
        previewCsv(path);
      });
    }
  } catch {
    // Non-critical — silently fail
  }
}

/**
 * Trigger a browser download for a CSV file.
 * @param {string} path - Relative path within the log directory
 */
function downloadCsv(path) {
  window.location.href = `/api/logs/csv-download?path=${encodeURIComponent(path)}`;
}

/**
 * Fetch and render a CSV preview inline. Toggle on re-click.
 * @param {string} path - Relative path within the log directory
 */
async function previewCsv(path) {
  const panel = document.getElementById('csv-preview-panel');
  const content = document.getElementById('csv-preview-content');
  if (!panel || !content) return;

  // Toggle off if clicking the same file
  if (currentPreviewPath === path && !panel.classList.contains('hidden')) {
    hideEl('csv-preview-panel');
    currentPreviewPath = '';
    return;
  }

  currentPreviewPath = path;
  content.innerHTML = '<p class="text-sm text-gray-500">Loading...</p>';
  panel.classList.remove('hidden');

  const filename = path.split('/').pop() || path;
  setText('csv-preview-title', `Preview: ${filename}`);

  try {
    const data = await apiGet(`/api/logs/csv-preview?path=${encodeURIComponent(path)}`);

    if (data.error) {
      content.innerHTML = `<p class="text-sm text-red-600">${data.error}</p>`;
      return;
    }

    const columns = /** @type {string[]} */ (data.columns || []);
    const rows = /** @type {Array<Record<string, string>>} */ (data.rows || []);

    if (columns.length === 0) {
      content.innerHTML = '<p class="text-sm text-gray-500">Empty CSV</p>';
      return;
    }

    let tableHtml = '<table class="w-full text-xs divide-y divide-gray-200">';
    tableHtml += '<thead class="bg-gray-50"><tr>';
    for (const col of columns) {
      tableHtml += `<th class="px-3 py-2 text-left font-medium text-gray-500 uppercase">${col}</th>`;
    }
    tableHtml += '</tr></thead><tbody class="divide-y divide-gray-200">';
    for (const row of rows) {
      tableHtml += '<tr>';
      for (const col of columns) {
        const val = row[col] ?? '';
        tableHtml += `<td class="px-3 py-2 text-gray-700 whitespace-nowrap">${val}</td>`;
      }
      tableHtml += '</tr>';
    }
    tableHtml += '</tbody></table>';
    content.innerHTML = tableHtml;
  } catch {
    content.innerHTML = '<p class="text-sm text-red-600">Failed to load CSV preview</p>';
  }
}

/** Reset all filters and reload. */
export function clearFilters() {
  state.logFilters = { date: null, level: null, category: null, search: '' };
  state.logPagination = { offset: 0, limit: 100 };

  const { date, level, category, search } = getFilterEls();
  if (date) date.value = '';
  if (level) level.value = '';
  if (category) category.value = '';
  if (search) search.value = '';

  loadLogEntries();
  loadLogStats();
}

/** Read current filter values from the DOM into state and reload. */
function applyFilters() {
  const { date, level, category, search } = getFilterEls();

  state.logFilters.date = date?.value || null;
  state.logFilters.level = level?.value || null;
  state.logFilters.category = category?.value || null;
  state.logFilters.search = search?.value || '';
  state.logPagination.offset = 0;

  loadLogEntries();
}

/** Initialize the logs page: load data and wire event handlers. */
export function initLogs() {
  // Reset state
  state.logFilters = { date: null, level: null, category: null, search: '' };
  state.logPagination = { offset: 0, limit: 100 };

  // Initial load
  loadLogEntries();
  loadLogStats();
  loadCsvFiles();

  // CSV section toggle
  const csvToggle = document.getElementById('csv-section-toggle');
  const csvBody = document.getElementById('csv-section-body');
  const csvIcon = document.getElementById('csv-toggle-icon');
  if (csvToggle && csvBody) {
    csvToggle.addEventListener('click', () => {
      csvBody.classList.toggle('hidden');
      csvIcon?.classList.toggle('rotate-90');
    });
  }

  // CSV preview close button
  document.getElementById('csv-preview-close')?.addEventListener('click', () => {
    hideEl('csv-preview-panel');
    currentPreviewPath = '';
  });

  // Filter controls
  const { date: dateEl, level: levelEl, category: catEl, search: searchEl } = getFilterEls();
  const clearBtn = document.getElementById('clear-filters-btn');
  const syncBtn = document.getElementById('sync-logs-btn');
  const prevBtn = document.getElementById('prev-page-btn');
  const nextBtn = document.getElementById('next-page-btn');

  if (dateEl) dateEl.addEventListener('change', applyFilters);
  if (levelEl) levelEl.addEventListener('change', applyFilters);
  if (catEl) catEl.addEventListener('change', applyFilters);

  // Debounced search
  if (searchEl) {
    searchEl.addEventListener('input', debounce(applyFilters, 300));
  }

  if (clearBtn) clearBtn.addEventListener('click', clearFilters);
  if (syncBtn) syncBtn.addEventListener('click', syncLogs);

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      state.logPagination.offset = Math.max(
        0,
        state.logPagination.offset - state.logPagination.limit,
      );
      loadLogEntries();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      state.logPagination.offset += state.logPagination.limit;
      loadLogEntries();
    });
  }
}
