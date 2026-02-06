import { connectAnalysisProgressStream, initializeAnalysisTableFromPaths } from './analysis.js';
/**
 * Folder browser modal and scan results for folder-based upload.
 */
import state from './state.js';
import { setUploadStep, showUploadSteps } from './stepper.js';
import { formatBytes, showNotification } from './utils.js';

/**
 * Initialize folder browser modal handlers.
 */
export function initFolderBrowser() {
  const modal = document.getElementById('folder-browser-modal');
  if (!modal) return;

  document.getElementById('close-folder-browser')?.addEventListener('click', closeFolderBrowser);
  document.getElementById('cancel-folder-browser')?.addEventListener('click', closeFolderBrowser);

  modal.addEventListener('click', (e) => {
    if (e.target === modal.querySelector('.fixed.inset-0')) {
      closeFolderBrowser();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeFolderBrowser();
    }
  });

  document.getElementById('select-current-folder')?.addEventListener('click', selectCurrentFolder);

  // Delegated click handler for folder navigation
  const folderList = document.getElementById('folder-list');
  if (folderList) {
    folderList.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target).closest(
        '[data-action="navigate-folder"]',
      );
      if (target) {
        loadFolderBrowser(/** @type {HTMLElement} */ (target).dataset.path || '');
      }
    });
  }

  const quickLinks = document.getElementById('folder-quick-links');
  if (quickLinks) {
    quickLinks.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target).closest(
        '[data-action="navigate-folder"]',
      );
      if (target) {
        loadFolderBrowser(/** @type {HTMLElement} */ (target).dataset.path || '');
      }
    });
  }

  const breadcrumb = document.getElementById('folder-breadcrumb');
  if (breadcrumb) {
    breadcrumb.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target).closest(
        '[data-action="navigate-folder"]',
      );
      if (target) {
        loadFolderBrowser(/** @type {HTMLElement} */ (target).dataset.path || '');
      }
    });
  }
}

export function closeFolderBrowser() {
  const modal = document.getElementById('folder-browser-modal');
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
}

/**
 * Open the folder browser modal.
 */
export async function openFolderBrowser() {
  const modal = document.getElementById('folder-browser-modal');
  if (modal) modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  const lastFolder = localStorage.getItem('lastUploadFolder');

  if (lastFolder) {
    loadFolderBrowser(lastFolder);
  } else {
    try {
      const response = await fetch('/api/settings');
      const settings = await response.json();
      if (settings.default_upload_folder) {
        loadFolderBrowser(settings.default_upload_folder);
      } else {
        loadFolderBrowser('');
      }
    } catch (_error) {
      loadFolderBrowser('');
    }
  }
}

/**
 * Load folder contents from the backend.
 * @param {string} path
 * @param {boolean} [isRetry]
 */
export async function loadFolderBrowser(path, isRetry = false) {
  const folderList = document.getElementById('folder-list');
  const loadingState = document.getElementById('folder-loading');
  const errorState = document.getElementById('folder-error');

  if (folderList) folderList.classList.add('hidden');
  if (errorState) errorState.classList.add('hidden');
  if (loadingState) loadingState.classList.remove('hidden');

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
                    <button class="px-3 py-1 text-sm bg-nrel-blue text-white hover:bg-nrel-blue-light rounded-md whitespace-nowrap"
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
                <button class="text-nrel-blue hover:underline whitespace-nowrap"
                        data-action="navigate-folder" data-path="${crumb.path}">
                    ${crumb.name}
                </button>
            `,
        )
        .join('');
    }

    // Update MCAP count
    const mcapCount = document.getElementById('folder-mcap-count');
    if (mcapCount) mcapCount.textContent = String(data.mcap_count);

    // Enable/disable select button
    const selectBtn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('select-current-folder')
    );
    if (selectBtn) {
      selectBtn.disabled = false;
      selectBtn.dataset.path = data.current_path;
    }

    // Render folder list
    if (loadingState) loadingState.classList.add('hidden');
    if (folderList) folderList.classList.remove('hidden');

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
                                <svg class="h-5 w-5 text-nrel-yellow mr-3" fill="currentColor" viewBox="0 0 20 20">
                                    <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                                </svg>
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
          ...data.files.slice(0, 10).map(
            (/** @type {{ name: string, size: number }} */ file) => `
                        <div class="px-6 py-3 flex items-center justify-between bg-gray-50">
                            <div class="flex items-center">
                                <svg class="h-5 w-5 text-gray-400 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                                <span class="text-sm text-gray-600">${file.name}</span>
                            </div>
                            <span class="text-xs text-gray-500">${formatBytes(file.size)}</span>
                        </div>
                    `,
          ),
          data.files.length > 10
            ? `
                        <div class="px-6 py-2 text-center text-xs text-gray-500">
                            ... and ${data.files.length - 10} more MCAP files
                        </div>
                    `
            : '',
        ].join('');
      }
    }
  } catch (error) {
    if (loadingState) loadingState.classList.add('hidden');
    if (errorState) errorState.classList.remove('hidden');

    const errorMessage = document.getElementById('folder-error-message');
    if (errorMessage) errorMessage.textContent = /** @type {Error} */ (error).message;
  }
}

/**
 * Select the current folder and scan for MCAP files.
 */
async function selectCurrentFolder() {
  const selectBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('select-current-folder')
  );
  if (!selectBtn) return;

  const folderPath = selectBtn.dataset.path;
  if (!folderPath) return;

  selectBtn.disabled = true;
  selectBtn.textContent = 'Scanning...';

  try {
    const response = await fetch('/api/upload/scan-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_path: folderPath }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to scan folder');
    }

    if (data.total_count === 0) {
      showNotification('No MCAP files found in this folder', 'error');
      return;
    }

    state.selectedFolderPath = folderPath;
    localStorage.setItem('lastUploadFolder', folderPath);

    closeFolderBrowser();

    const prefilterResponse = await fetch('/api/upload/bulk-analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_paths: data.files.map((/** @type {{ path: string }} */ f) => f.path),
        pre_filter_only: true,
      }),
    });

    const prefilterData = await prefilterResponse.json();

    showScanResults(data, prefilterData.pre_filter_stats || {});
  } catch (error) {
    showNotification(/** @type {Error} */ (error).message, 'error');
  } finally {
    selectBtn.disabled = false;
    selectBtn.textContent = 'Select This Folder';
  }
}

/**
 * Show scan results UI.
 * @param {any} scanData
 * @param {any} prefilterStats
 */
function showScanResults(scanData, prefilterStats) {
  const scanSection = document.getElementById('scan-results-section');
  const dropZone = document.getElementById('drop-zone');

  showUploadSteps(2);

  const selectedFolderPath = document.getElementById('selected-folder-path');
  if (selectedFolderPath) selectedFolderPath.textContent = scanData.folder_path;

  const scanTotal = document.getElementById('scan-total');
  if (scanTotal) scanTotal.textContent = String(scanData.total_count);

  const scanToUpload = document.getElementById('scan-to-upload');
  if (scanToUpload) {
    scanToUpload.textContent = String(prefilterStats.to_analyze || scanData.total_count);
  }

  const scanAlreadyUploaded = document.getElementById('scan-already-uploaded');
  if (scanAlreadyUploaded) {
    scanAlreadyUploaded.textContent = String(prefilterStats.cache_skipped || 0);
  }

  const fileStatuses = prefilterStats.file_statuses || [];
  state.scanFilePaths = fileStatuses
    .filter((/** @type {any} */ f) => !f.already_uploaded)
    .map((/** @type {any} */ f) => f.path);

  state.scanFileStatuses = fileStatuses;

  renderScanFileList(fileStatuses);

  const hideUploadedCheckbox = /** @type {HTMLInputElement | null} */ (
    document.getElementById('scan-hide-uploaded')
  );
  if (hideUploadedCheckbox) {
    hideUploadedCheckbox.checked = false;
    hideUploadedCheckbox.onchange = () => applyScanFileFilter();
  }

  const startBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('start-upload-btn')
  );
  if (startBtn) {
    startBtn.disabled = (prefilterStats.to_analyze || scanData.total_count) === 0;
  }

  if (dropZone) dropZone.classList.add('hidden');
  if (scanSection) scanSection.classList.remove('hidden');
}

/**
 * @param {any[]} fileStatuses
 */
function renderScanFileList(fileStatuses) {
  const fileList = document.getElementById('scan-file-list');
  if (!fileList) return;

  const sorted = [...fileStatuses].sort((a, b) => {
    if (a.already_uploaded === b.already_uploaded) {
      return a.filename.localeCompare(b.filename);
    }
    return a.already_uploaded ? 1 : -1;
  });

  fileList.innerHTML = sorted
    .map(
      (file) => `
        <div class="px-6 py-3 flex items-center justify-between ${file.already_uploaded ? 'bg-yellow-50' : ''}"
             data-already-uploaded="${file.already_uploaded}">
            <div class="flex items-center min-w-0">
                <svg class="h-5 w-5 ${file.already_uploaded ? 'text-yellow-500' : 'text-green-500'} mr-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    ${
                      file.already_uploaded
                        ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />'
                        : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />'
                    }
                </svg>
                <span class="text-sm ${file.already_uploaded ? 'text-gray-500' : 'text-gray-900'} truncate" title="${file.filename}">
                    ${file.filename}
                </span>
            </div>
            <div class="flex items-center space-x-4 flex-shrink-0">
                <span class="text-xs text-gray-500">${formatBytes(file.size)}</span>
                <span class="px-2 py-1 text-xs rounded-full ${file.already_uploaded ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'}">
                    ${file.already_uploaded ? 'Uploaded' : 'To Upload'}
                </span>
            </div>
        </div>
    `,
    )
    .join('');
}

function applyScanFileFilter() {
  const hideUploadedEl = /** @type {HTMLInputElement | null} */ (
    document.getElementById('scan-hide-uploaded')
  );
  const hideUploaded = hideUploadedEl?.checked || false;
  const fileList = document.getElementById('scan-file-list');
  if (!fileList) return;

  const items = fileList.querySelectorAll('[data-already-uploaded]');
  for (const item of items) {
    if (hideUploaded && /** @type {HTMLElement} */ (item).dataset.alreadyUploaded === 'true') {
      item.classList.add('hidden');
    } else {
      item.classList.remove('hidden');
    }
  }
}

/**
 * Start direct upload from scanned folder.
 */
export async function startDirectUpload() {
  if (!state.scanFilePaths || state.scanFilePaths.length === 0) {
    showNotification('No files to upload', 'error');
    return;
  }

  const startBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('start-upload-btn')
  );
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = 'Validating...';
  }

  try {
    const response = await fetch('/api/upload/bulk-analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_paths: state.scanFilePaths,
        auto_upload: false,
      }),
    });

    const data = await response.json();

    if (!response.ok && response.status !== 202) {
      throw new Error(data.error || 'Failed to start upload');
    }

    state.currentJobId = data.job_id;

    setUploadStep(3);

    document.getElementById('scan-results-section')?.classList.add('hidden');
    document.getElementById('analysis-section')?.classList.remove('hidden');

    initializeAnalysisTableFromPaths(state.scanFilePaths);
    connectAnalysisProgressStream(data.job_id);
  } catch (error) {
    showNotification(/** @type {Error} */ (error).message, 'error');
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = 'Validate Files';
    }
  }
}
