import { connectCombinedProgressStream } from './analysis.js';
import { apiGet, apiPost } from './api.js';
import { hideEl, setText, showEl } from './dom.js';
import { formatBytes, formatMtime } from './formatters.js';
import { fileIcon, folderIcon } from './icons.js';
import { showNotification } from './notify.js';
import { toggleSort, updateSortIndicators } from './sorting-helpers.js';
/**
 * Inline folder browser and scan results for folder-based upload.
 */
import state from './state.js';
import { setUploadStep, showUploadSteps } from './stepper.js';

/**
 * Initialize the inline folder browser and auto-load initial folder.
 */
export async function initFolderBrowser() {
  const panel = document.getElementById('folder-browser-panel');
  if (!panel) return;

  document.getElementById('select-folder-btn')?.addEventListener('click', selectCurrentFolder);

  // Delegated click handler for folder navigation (shared across 3 containers)
  /** @param {Event} e */
  function handleFolderNavClick(e) {
    const target = /** @type {HTMLElement} */ (e.target).closest('[data-action="navigate-folder"]');
    if (target) {
      loadFolderBrowser(/** @type {HTMLElement} */ (target).dataset.path || '');
    }
  }

  document.getElementById('folder-list')?.addEventListener('click', handleFolderNavClick);
  document.getElementById('folder-quick-links')?.addEventListener('click', handleFolderNavClick);
  document.getElementById('folder-breadcrumb')?.addEventListener('click', handleFolderNavClick);

  // Sort header click handler (Review table)
  const scanSection = document.getElementById('scan-results-section');
  if (scanSection) {
    scanSection.addEventListener('click', (e) => {
      const th = /** @type {HTMLElement} */ (e.target).closest('[data-sort]');
      if (th) {
        sortReviewTable(/** @type {HTMLElement} */ (th).dataset.sort || 'filename');
      }
    });
  }

  // Sort header click handler (File browser table)
  const fileTableHead = document.getElementById('file-table-head');
  if (fileTableHead) {
    fileTableHead.addEventListener('click', (e) => {
      const th = /** @type {HTMLElement} */ (e.target).closest('[data-file-sort]');
      if (th) {
        sortBrowserFileTable(/** @type {HTMLElement} */ (th).dataset.fileSort || 'name');
      }
    });
  }

  // Auto-load: use last folder or default from settings
  const lastFolder = localStorage.getItem('lastUploadFolder');
  if (lastFolder) {
    loadFolderBrowser(lastFolder);
  } else {
    try {
      const settings = await apiGet('/api/settings');
      loadFolderBrowser(settings.default_upload_folder || '');
    } catch (_error) {
      loadFolderBrowser('');
    }
  }
}

/**
 * Load folder contents from the backend.
 * Uses raw fetch for complex retry-on-failure logic.
 * @param {string} path
 * @param {boolean} [isRetry]
 */
export async function loadFolderBrowser(path, isRetry = false) {
  hideEl('folder-list');
  hideEl('folder-error');
  showEl('folder-loading');

  try {
    const url = path ? `/api/files/browse?path=${encodeURIComponent(path)}` : '/api/files/browse';
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      if (path && !isRetry) {
        console.warn(`Failed to load saved folder "${path}", falling back to home`);
        loadFolderBrowser('', true);
        return;
      }
      throw new Error(data.error || 'Failed to load folder');
    }

    // Update quick links (using data-action instead of onclick)
    const quickLinksContainer = document.getElementById('folder-quick-links');
    if (quickLinksContainer) {
      const lastUsedFolder = localStorage.getItem('lastUploadFolder');
      let quickLinksHtml = '';

      if (lastUsedFolder && lastUsedFolder !== data.current_path) {
        const lastFolderName = lastUsedFolder.split('/').pop() || lastUsedFolder;
        quickLinksHtml += `
                    <button class="px-3 py-1 text-sm bg-nlr-blue text-white hover:bg-nlr-blue-light rounded-md whitespace-nowrap"
                            data-action="navigate-folder" data-path="${lastUsedFolder}">
                        Last: ${lastFolderName}
                    </button>
                `;
      }

      quickLinksHtml += data.quick_links
        .map(
          (/** @type {{ name: string, path: string }} */ link) => `
                <button class="px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 rounded-md whitespace-nowrap"
                        data-action="navigate-folder" data-path="${link.path}">
                    ${link.name}
                </button>
            `,
        )
        .join('');

      quickLinksContainer.innerHTML = quickLinksHtml;
    }

    // Update breadcrumbs
    const breadcrumbContainer = document.getElementById('folder-breadcrumb');
    if (breadcrumbContainer) {
      breadcrumbContainer.innerHTML = data.breadcrumbs
        .map(
          (/** @type {{ name: string, path: string }} */ crumb, /** @type {number} */ i) => `
                ${i > 0 ? '<span class="text-gray-400">/</span>' : ''}
                <button class="text-nlr-blue hover:underline whitespace-nowrap"
                        data-action="navigate-folder" data-path="${crumb.path}">
                    ${crumb.name}
                </button>
            `,
        )
        .join('');
    }

    // Update MCAP count
    setText('folder-mcap-count', data.mcap_count);

    // Enable select button and store current path
    const selectFolderBtn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('select-folder-btn')
    );
    if (selectFolderBtn) {
      selectFolderBtn.disabled = false;
      selectFolderBtn.dataset.path = data.current_path;
    }

    // Update bottom summary with MCAP count
    if (data.mcap_count > 0) {
      setText(
        'folder-select-summary',
        `${data.mcap_count} MCAP file${data.mcap_count === 1 ? '' : 's'} in this folder.`,
      );
    } else {
      setText(
        'folder-select-summary',
        'Navigate to the folder containing your MCAP files, then click Upload Folder.',
      );
    }

    // Render folder list
    hideEl('folder-loading');
    showEl('folder-list');

    const folderList = document.getElementById('folder-list');
    if (folderList) {
      if (data.folders.length === 0 && data.files.length === 0) {
        folderList.innerHTML =
          '<div class="p-8 text-center text-gray-500">This folder is empty</div>';
      } else {
        folderList.innerHTML = [
          data.parent_path
            ? `
                        <div class="px-6 py-3 flex items-center cursor-pointer hover:bg-gray-50"
                             data-action="navigate-folder" data-path="${data.parent_path}">
                            <svg class="h-5 w-5 text-gray-400 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 17l-5-5m0 0l5-5m-5 5h12" />
                            </svg>
                            <span class="text-sm text-gray-600">..</span>
                        </div>
                    `
            : '',
          ...data.folders.map(
            (/** @type {{ name: string, path: string, mcap_count: number }} */ folder) => `
                        <div class="px-6 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50"
                             data-action="navigate-folder" data-path="${folder.path}">
                            <div class="flex items-center">
                                ${folderIcon()}
                                <span class="text-sm font-medium text-gray-900">${folder.name}</span>
                            </div>
                            ${
                              folder.mcap_count > 0
                                ? `<span class="text-xs text-gray-500" title="Direct files only, not including subfolders">${folder.mcap_count} mcap</span>`
                                : ''
                            }
                        </div>
                    `,
          ),
        ].join('');
      }
    }

    // Render MCAP file table
    if (data.files.length > 0) {
      state.browserFiles = data.files;
      state.browserFileSortConfig = state.browserFileSortConfig || {
        column: 'name',
        ascending: true,
      };
      renderBrowserFileTable();
      showEl('file-table-section');
    } else {
      state.browserFiles = [];
      hideEl('file-table-section');
    }
  } catch (error) {
    hideEl('folder-loading');
    showEl('folder-error');
    setText('folder-error-message', /** @type {Error} */ (error).message);
  }
}

/**
 * Select the current folder and scan for MCAP files.
 */
async function selectCurrentFolder() {
  const btn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('select-folder-btn')
  );
  if (!btn) return;

  const folderPath = btn.dataset.path;
  if (!folderPath) return;

  btn.disabled = true;
  const btnSpan = btn.querySelector('span');
  if (btnSpan) btnSpan.textContent = 'Scanning...';

  try {
    const data = await apiPost('/api/upload/scan-folder', { folder_path: folderPath });

    if (data.total_count === 0) {
      showNotification('No MCAP files found in this folder', 'error');
      return;
    }

    state.selectedFolderPath = folderPath;
    localStorage.setItem('lastUploadFolder', folderPath);

    const prefilterData = await apiPost('/api/upload/bulk-analyze', {
      file_paths: data.files.map((/** @type {{ path: string }} */ f) => f.path),
      pre_filter_only: true,
    });

    showScanResults(data, prefilterData.pre_filter_stats || {});
  } catch (error) {
    showNotification(/** @type {Error} */ (error).message, 'error');
  } finally {
    btn.disabled = false;
    const resetSpan = btn.querySelector('span');
    if (resetSpan) resetSpan.textContent = 'Upload This Folder';
  }
}

/**
 * Show scan results UI with sortable review table.
 * @param {any} scanData
 * @param {any} prefilterStats
 */
function showScanResults(scanData, prefilterStats) {
  showUploadSteps(2);

  // Store folder path for relative path computation
  state.scanFolderPath = scanData.folder_path;
  state.scanTotalSize = scanData.total_size || 0;

  setText('selected-folder-path', scanData.folder_path);
  setText('scan-total', scanData.total_count);
  setText('scan-total-volume', formatBytes(state.scanTotalSize));
  setText('scan-already-uploaded', prefilterStats.cache_skipped || 0);

  // Merge scan data files with prefilter statuses
  const fileStatuses = prefilterStats.file_statuses || [];
  /** @type {Map<string, any>} */
  const prefilterMap = new Map();
  for (const fs of fileStatuses) {
    prefilterMap.set(fs.path, fs);
  }

  /** @type {Array<any>} */
  const mergedStatuses = [];
  for (const scanFile of scanData.files) {
    const pf = prefilterMap.get(scanFile.path);
    mergedStatuses.push({
      path: scanFile.path,
      filename: scanFile.filename,
      size: scanFile.size,
      mtime: scanFile.mtime || 0,
      relative_path: scanFile.relative_path || scanFile.filename,
      already_uploaded: pf ? pf.already_uploaded : false,
    });
  }

  state.scanFilePaths = mergedStatuses
    .filter((/** @type {any} */ f) => !f.already_uploaded)
    .map((/** @type {any} */ f) => f.path);

  state.scanFileStatuses = mergedStatuses;
  state.reviewSortConfig = { column: 'filename', ascending: true };

  renderReviewTable(mergedStatuses);

  const hideUploadedCheckbox = /** @type {HTMLInputElement | null} */ (
    document.getElementById('scan-hide-uploaded')
  );
  if (hideUploadedCheckbox) {
    hideUploadedCheckbox.checked = false;
    hideUploadedCheckbox.onchange = () => applyScanFileFilter();
  }

  const continueBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('continue-upload-btn')
  );
  if (continueBtn) {
    continueBtn.disabled = state.scanFileStatuses.length === 0;
  }

  hideEl('folder-browser-panel');
  showEl('scan-results-section');
}

/**
 * Render the sortable review table body.
 * @param {any[]} fileStatuses
 */
function renderReviewTable(fileStatuses) {
  const tbody = document.getElementById('scan-file-list');
  if (!tbody) return;

  const { column, ascending } = state.reviewSortConfig;

  const sorted = [...fileStatuses].sort((a, b) => {
    let cmp = 0;
    if (column === 'filename') {
      cmp = a.filename.localeCompare(b.filename);
    } else if (column === 'path') {
      const aDir = getDirectoryPart(a.relative_path);
      const bDir = getDirectoryPart(b.relative_path);
      cmp = aDir.localeCompare(bDir);
    } else if (column === 'mtime') {
      cmp = (a.mtime || 0) - (b.mtime || 0);
    } else if (column === 'size') {
      cmp = a.size - b.size;
    } else if (column === 'status') {
      cmp = Number(a.already_uploaded) - Number(b.already_uploaded);
    }
    return ascending ? cmp : -cmp;
  });

  tbody.innerHTML = sorted
    .map((file) => {
      const dirPath = getDirectoryPart(file.relative_path);

      return `
        <tr class="${file.already_uploaded ? 'bg-yellow-50' : ''}"
            data-already-uploaded="${file.already_uploaded}">
            <td class="px-4 py-3">
                <span class="text-sm ${file.already_uploaded ? 'text-gray-500' : 'text-gray-900'} truncate block" title="${file.filename}">
                    ${file.filename}
                </span>
            </td>
            <td class="px-4 py-3">
                <span class="text-sm text-gray-500 truncate block" title="${dirPath}">${dirPath || '.'}</span>
            </td>
            <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-500">${formatMtime(file.mtime)}</td>
            <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-500">${formatBytes(file.size)}</td>
            <td class="px-4 py-3 whitespace-nowrap">
                <span class="px-2 py-1 text-xs rounded-full ${file.already_uploaded ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'}">
                    ${file.already_uploaded ? 'Uploaded' : 'To Upload'}
                </span>
            </td>
        </tr>
    `;
    })
    .join('');

  // Update sort indicators
  updateSortIndicators('[data-sort]', '.sort-indicator', 'sort', column, ascending);

  // Re-apply filter
  applyScanFileFilter();
}

/**
 * Get the directory part of a relative path (everything before the filename).
 * @param {string} relativePath
 * @returns {string}
 */
function getDirectoryPart(relativePath) {
  const lastSlash = relativePath.lastIndexOf('/');
  return lastSlash >= 0 ? relativePath.substring(0, lastSlash) : '';
}

/**
 * Sort the review table by column.
 * @param {string} column
 */
function sortReviewTable(column) {
  toggleSort(state.reviewSortConfig, column);
  renderReviewTable(state.scanFileStatuses);
}

function applyScanFileFilter() {
  const hideUploadedEl = /** @type {HTMLInputElement | null} */ (
    document.getElementById('scan-hide-uploaded')
  );
  const hideUploaded = hideUploadedEl?.checked || false;
  const tbody = document.getElementById('scan-file-list');
  if (!tbody) return;

  const rows = tbody.querySelectorAll('[data-already-uploaded]');
  for (const row of rows) {
    if (hideUploaded && /** @type {HTMLElement} */ (row).dataset.alreadyUploaded === 'true') {
      row.classList.add('hidden');
    } else {
      row.classList.remove('hidden');
    }
  }
}

/**
 * Show the confirm upload modal.
 */
export function showConfirmModal() {
  if (!state.scanFileStatuses || state.scanFileStatuses.length === 0) {
    showNotification('No files to upload', 'error');
    return;
  }

  // Calculate size of non-uploaded files (default view)
  updateConfirmModalCounts(false);

  // Wire up force-reupload checkbox to update counts dynamically
  const checkbox = /** @type {HTMLInputElement | null} */ (
    document.getElementById('force-reupload-checkbox')
  );
  if (checkbox) {
    checkbox.checked = false;
    checkbox.onchange = () => updateConfirmModalCounts(checkbox.checked);
  }

  showEl('confirm-skip-note');
  showEl('confirm-upload-modal');
}

/**
 * Update confirm modal file count/size based on force-reupload state.
 * @param {boolean} forceReupload
 */
function updateConfirmModalCounts(forceReupload) {
  let uploadSize = 0;
  let uploadCount = 0;
  for (const file of state.scanFileStatuses) {
    if (forceReupload || !file.already_uploaded) {
      uploadSize += file.size;
      uploadCount++;
    }
  }

  setText('confirm-file-count', uploadCount);
  setText('confirm-total-size', formatBytes(uploadSize));

  if (forceReupload) {
    hideEl('confirm-skip-note');
  } else {
    showEl('confirm-skip-note');
  }
}

/**
 * Start the combined validate + upload flow.
 */
export async function startCombinedUpload() {
  // Close confirm modal
  hideEl('confirm-upload-modal');

  // Check force-reupload state
  const forceCheckbox = /** @type {HTMLInputElement | null} */ (
    document.getElementById('force-reupload-checkbox')
  );
  const forceReupload = forceCheckbox?.checked || false;

  // Determine which file paths to send
  const filePaths = forceReupload
    ? state.scanFileStatuses.map((/** @type {any} */ f) => f.path)
    : state.scanFilePaths;

  if (!filePaths || filePaths.length === 0) {
    showNotification('No files to upload', 'error');
    return;
  }

  setUploadStep(3);

  hideEl('scan-results-section');
  showEl('upload-section');

  // Set phase label
  setText('upload-phase-label', 'Validating files...');

  // Initialize file list with pending status
  initUploadFileList(filePaths);

  try {
    /** @type {Record<string, any>} */
    const requestBody = {
      file_paths: filePaths,
      auto_upload: true,
    };
    if (forceReupload) {
      requestBody.skip_duplicates = false;
    }

    const data = await apiPost('/api/upload/bulk-analyze', requestBody);

    state.currentJobId = data.job_id;
    setText('files-total', data.total_files);

    connectCombinedProgressStream(data.job_id);
  } catch (error) {
    showNotification(/** @type {Error} */ (error).message, 'error');
  }
}

/**
 * Render the sortable file table in the folder browser.
 */
function renderBrowserFileTable() {
  const tbody = document.getElementById('file-table-body');
  if (!tbody || !state.browserFiles) return;

  const { column, ascending } = state.browserFileSortConfig;

  const sorted = [...state.browserFiles].sort((a, b) => {
    let cmp = 0;
    if (column === 'name') {
      cmp = a.name.localeCompare(b.name);
    } else if (column === 'mtime') {
      cmp = (a.mtime || 0) - (b.mtime || 0);
    } else if (column === 'size') {
      cmp = a.size - b.size;
    }
    return ascending ? cmp : -cmp;
  });

  tbody.innerHTML = sorted
    .map(
      (/** @type {{ name: string, size: number, mtime: number }} */ file) => `
          <tr class="hover:bg-gray-50">
            <td class="px-6 py-2">
              <div class="flex items-center">
                ${fileIcon('h-4 w-4 text-gray-400 mr-2 flex-shrink-0')}
                <span class="text-sm text-gray-600 truncate">${file.name}</span>
              </div>
            </td>
            <td class="px-4 py-2 text-sm text-gray-500 whitespace-nowrap">${formatMtime(file.mtime)}</td>
            <td class="px-4 py-2 text-sm text-gray-500 text-right whitespace-nowrap">${formatBytes(file.size)}</td>
          </tr>
        `,
    )
    .join('');

  // Update sort indicators
  updateSortIndicators('[data-file-sort]', '.file-sort-indicator', 'fileSort', column, ascending);
}

/**
 * Sort the browser file table by column.
 * @param {string} column
 */
function sortBrowserFileTable(column) {
  if (!state.browserFileSortConfig) {
    state.browserFileSortConfig = { column, ascending: true };
  } else {
    toggleSort(state.browserFileSortConfig, column);
  }
  renderBrowserFileTable();
}

/**
 * Initialize the upload file list with queued status.
 * @param {string[]} filePaths
 */
function initUploadFileList(filePaths) {
  const listEl = document.getElementById('upload-file-list');
  if (!listEl) return;

  const total = filePaths.length;
  listEl.innerHTML = filePaths
    .map((path, index) => {
      const filename = path.split('/').pop() || path;
      return `
        <div class="px-6 py-3 flex items-center justify-between" data-upload-file="${filename}">
            <div class="flex items-center space-x-3">
                <div class="h-5 w-5 text-gray-400">
                    <svg class="h-5 w-5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                </div>
                <span class="text-sm text-gray-900">${filename}</span>
            </div>
            <span data-queue-label class="text-xs text-gray-500">Queued (${index + 1} of ${total})</span>
        </div>
      `;
    })
    .join('');
}
