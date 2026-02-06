/**
 * S3 file browser page functionality.
 */
import state from './state.js';
import { formatBytes, showNotification } from './utils.js';

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

  let searchTimeout = 0;
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = window.setTimeout(() => {
      const query = searchInput.value.trim();
      if (query.length >= 2) {
        searchFiles(query);
      } else {
        hideSearchResults();
      }
    }, 300);
  });

  loadSettings().then(() => loadFiles(''));
}

async function loadSettings() {
  try {
    const response = await fetch('/api/settings');
    const settings = await response.json();

    const bucketName = document.getElementById('bucket-name');
    if (bucketName) bucketName.textContent = settings.s3_bucket || 'No bucket configured';
  } catch (_error) {
    const bucketName = document.getElementById('bucket-name');
    if (bucketName) bucketName.textContent = 'Error loading settings';
  }
}

/**
 * @param {string} prefix
 */
async function loadFiles(prefix) {
  state.currentPrefix = prefix;

  document.getElementById('loading-state')?.classList.remove('hidden');
  document.getElementById('error-state')?.classList.add('hidden');
  document.getElementById('empty-state')?.classList.add('hidden');
  document.getElementById('file-list')?.classList.add('hidden');

  try {
    const response = await fetch(`/api/files/list?prefix=${encodeURIComponent(prefix)}`);
    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to load files');
    }

    document.getElementById('loading-state')?.classList.add('hidden');

    updateBreadcrumb(data.breadcrumbs || []);

    if (data.folders.length === 0 && data.files.length === 0) {
      document.getElementById('empty-state')?.classList.remove('hidden');
      return;
    }

    displayFiles(data.folders, data.files);
  } catch (error) {
    document.getElementById('loading-state')?.classList.add('hidden');
    document.getElementById('error-state')?.classList.remove('hidden');

    const errorMessage = document.getElementById('error-message');
    if (errorMessage) errorMessage.textContent = /** @type {Error} */ (error).message;
  }
}

/**
 * @param {Array<{ name: string, prefix: string }>} breadcrumbs
 */
function updateBreadcrumb(breadcrumbs) {
  const nav = document.getElementById('breadcrumb');
  if (!nav) return;

  nav.innerHTML = `
        <a href="#" data-prefix="" class="text-nrel-blue hover:underline">Root</a>
        ${breadcrumbs
          .map(
            (b) => `
            <span class="text-gray-400">/</span>
            <a href="#" data-prefix="${b.prefix}" class="text-nrel-blue hover:underline">${b.name}</a>
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
                <svg class="h-5 w-5 text-nrel-yellow mr-3" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                </svg>
                <span class="text-sm font-medium text-gray-900">${folder.name}/</span>
            </div>
        `,
    ),
    ...files.map(
      (file) => `
            <div class="file-item px-6 py-3 flex items-center justify-between">
                <div class="flex items-center">
                    <svg class="h-5 w-5 text-gray-400 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
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

  fileList.classList.remove('hidden');

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
    const response = await fetch(
      `/api/files/search?query=${encodeURIComponent(query)}&prefix=${encodeURIComponent(state.currentPrefix)}`,
    );
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Search failed');
    }

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
                        <svg class="h-5 w-5 text-gray-400 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
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

  container.classList.remove('hidden');
}

function hideSearchResults() {
  document.getElementById('search-results')?.classList.add('hidden');

  const searchInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById('search-input')
  );
  if (searchInput) searchInput.value = '';
}
