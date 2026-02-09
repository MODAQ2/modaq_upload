/**
 * S3 file browser page functionality.
 */
import { apiGet } from './api.js';
import { debounce } from './debounce.js';
import { hideEl, setText, showEl } from './dom.js';
import { formatBytes } from './formatters.js';
import { fileIcon, folderIcon } from './icons.js';
import { showNotification } from './notify.js';
import state from './state.js';

export function initFileBrowser() {
  const refreshBtn = document.getElementById('refresh-btn');
  const searchInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById('search-input')
  );
  const retryBtn = document.getElementById('retry-btn');
  const closeSearchBtn = document.getElementById('close-search-btn');

  if (!refreshBtn) return;

  refreshBtn.addEventListener('click', () => loadFiles(state.currentPrefix));
  retryBtn?.addEventListener('click', () => loadFiles(state.currentPrefix));
  closeSearchBtn?.addEventListener('click', hideSearchResults);

  const debouncedSearch = debounce(() => {
    const query = searchInput?.value.trim() || '';
    if (query.length >= 2) {
      searchFiles(query);
    } else {
      hideSearchResults();
    }
  }, 300);
  searchInput?.addEventListener('input', debouncedSearch);

  loadSettings().then(() => loadFiles(''));
}

async function loadSettings() {
  try {
    const settings = await apiGet('/api/settings');
    setText('bucket-name', settings.s3_bucket || 'No bucket configured');
  } catch (_error) {
    setText('bucket-name', 'Error loading settings');
  }
}

/**
 * @param {string} prefix
 */
async function loadFiles(prefix) {
  state.currentPrefix = prefix;

  showEl('loading-state');
  hideEl('error-state');
  hideEl('empty-state');
  hideEl('file-list');

  try {
    const data = await apiGet(`/api/files/list?prefix=${encodeURIComponent(prefix)}`);

    if (!data.success) {
      throw new Error(data.error || 'Failed to load files');
    }

    hideEl('loading-state');

    updateBreadcrumb(data.breadcrumbs || []);

    if (data.folders.length === 0 && data.files.length === 0) {
      showEl('empty-state');
      return;
    }

    displayFiles(data.folders, data.files);
  } catch (error) {
    hideEl('loading-state');
    showEl('error-state');
    setText('error-message', /** @type {Error} */ (error).message);
  }
}

/**
 * @param {Array<{ name: string, prefix: string }>} breadcrumbs
 */
function updateBreadcrumb(breadcrumbs) {
  const nav = document.getElementById('breadcrumb');
  if (!nav) return;

  nav.innerHTML = `
        <a href="#" data-prefix="" class="text-nlr-blue hover:underline">Root</a>
        ${breadcrumbs
          .map(
            (b) => `
            <span class="text-gray-400">/</span>
            <a href="#" data-prefix="${b.prefix}" class="text-nlr-blue hover:underline">${b.name}</a>
        `,
          )
          .join('')}
    `;

  for (const link of nav.querySelectorAll('a')) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      loadFiles(/** @type {HTMLElement} */ (link).dataset.prefix || '');
    });
  }
}

/**
 * @param {Array<{ name: string, prefix: string }>} folders
 * @param {Array<{ name: string, key: string, size: number, last_modified?: string }>} files
 */
function displayFiles(folders, files) {
  const fileList = document.getElementById('file-list');
  if (!fileList) return;

  fileList.innerHTML = [
    ...folders.map(
      (folder) => `
            <div class="file-item px-6 py-3 flex items-center cursor-pointer" data-prefix="${folder.prefix}">
                ${folderIcon()}
                <span class="text-sm font-medium text-gray-900">${folder.name}/</span>
            </div>
        `,
    ),
    ...files.map(
      (file) => `
            <div class="file-item px-6 py-3 flex items-center justify-between">
                <div class="flex items-center">
                    ${fileIcon()}
                    <span class="text-sm text-gray-900">${file.name}</span>
                </div>
                <div class="flex items-center space-x-4 text-sm text-gray-500">
                    <span>${formatBytes(file.size)}</span>
                    <span>${file.last_modified ? new Date(file.last_modified).toLocaleString() : '-'}</span>
                </div>
            </div>
        `,
    ),
  ].join('');

  showEl('file-list');

  for (const el of fileList.querySelectorAll('[data-prefix]')) {
    el.addEventListener('click', () =>
      loadFiles(/** @type {HTMLElement} */ (el).dataset.prefix || ''),
    );
  }
}

/**
 * @param {string} query
 */
async function searchFiles(query) {
  try {
    const data = await apiGet(
      `/api/files/search?query=${encodeURIComponent(query)}&prefix=${encodeURIComponent(state.currentPrefix)}`,
    );
    showSearchResults(data.files, query);
  } catch (error) {
    showNotification(/** @type {Error} */ (error).message, 'error');
  }
}

/**
 * @param {Array<{ name: string, key: string, size: number }>} files
 * @param {string} _query
 */
function showSearchResults(files, _query) {
  const container = document.getElementById('search-results');
  const list = document.getElementById('search-results-list');
  if (!container || !list) return;

  list.innerHTML =
    files.length === 0
      ? '<div class="px-6 py-4 text-center text-gray-500">No files found</div>'
      : files
          .map(
            (file) => `
                <div class="px-6 py-3 flex items-center justify-between">
                    <div class="flex items-center">
                        ${fileIcon()}
                        <div>
                            <div class="text-sm text-gray-900">${file.name}</div>
                            <div class="text-xs text-gray-500">${file.key}</div>
                        </div>
                    </div>
                    <span class="text-sm text-gray-500">${formatBytes(file.size)}</span>
                </div>
            `,
          )
          .join('');

  showEl('search-results');
}

function hideSearchResults() {
  hideEl('search-results');

  const searchInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById('search-input')
  );
  if (searchInput) searchInput.value = '';
}
