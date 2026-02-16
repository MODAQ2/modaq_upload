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

  // Click handler for Review table (folder expand/collapse)
  const scanSection = document.getElementById('scan-results-section');
  if (scanSection) {
    scanSection.addEventListener('click', (e) => {
      const folderHeader = /** @type {HTMLElement} */ (e.target).closest('[data-folder-header]');
      if (folderHeader) {
        toggleFolderExpand(/** @type {HTMLTableRowElement} */ (folderHeader));
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
                             data-action="navigate-folder" data-path="${folder.path}"
                             data-folder-name="${folder.name}">
                            <div class="flex items-center">
                                ${folderIcon()}
                                <span class="text-sm font-medium text-gray-900">${folder.name}</span>
                            </div>
                            ${
                              folder.mcap_count > 0
                                ? `<span class="folder-mcap-badge text-xs text-gray-500" title="Direct files only, not including subfolders">${folder.mcap_count} mcap</span>`
                                : '<span class="folder-mcap-badge text-xs text-gray-500"></span>'
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

    // Start background scan for upload status enrichment
    startBrowserScan(data.current_path);
  } catch (error) {
    hideEl('folder-loading');
    showEl('folder-error');
    setText('folder-error-message', /** @type {Error} */ (error).message);
  }
}

/**
 * Select the current folder and populate Step 2 from stored browser scan data.
 * The browser scan has already accumulated state.scanFileStatuses and state.scanFilePaths.
 */
function selectCurrentFolder() {
  const btn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('select-folder-btn')
  );
  if (!btn) return;

  const folderPath = btn.dataset.path;
  if (!folderPath) return;

  state.selectedFolderPath = folderPath;
  state.scanFolderPath = folderPath;
  localStorage.setItem('lastUploadFolder', folderPath);

  // Transition to Step 2 — populate from stored browser scan data
  showUploadSteps(2);
  state.reviewSortConfig = { column: 'filename', ascending: true };

  setText('selected-folder-path', folderPath);
  setText('scan-total', String(state.scanFileStatuses.length));
  setText('scan-total-volume', formatBytes(state.scanTotalSize));
  const uploadedCount = state.scanFileStatuses.filter(
    (/** @type {any} */ f) => f.already_uploaded,
  ).length;
  setText('scan-already-uploaded', String(uploadedCount));

  // Clear and populate review table from stored scan results
  const tbody = document.getElementById('scan-file-list');
  if (tbody) tbody.innerHTML = '';

  for (let i = 0; i < state.browserScanResults.length; i++) {
    appendFolderToReviewTable(state.browserScanResults[i], i);
  }

  // Hide scan progress (scan already done), enable continue button
  hideEl('scan-progress-container');
  const continueBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('continue-upload-btn')
  );
  if (continueBtn) {
    continueBtn.disabled = state.scanFilePaths.length === 0;
  }

  const hideUploadedCheckbox = /** @type {HTMLInputElement | null} */ (
    document.getElementById('scan-hide-uploaded')
  );
  if (hideUploadedCheckbox) {
    hideUploadedCheckbox.checked = false;
    hideUploadedCheckbox.onchange = () => applyScanFileFilter();
  }

  const hideCompletedFoldersCheckbox = /** @type {HTMLInputElement | null} */ (
    document.getElementById('scan-hide-completed-folders')
  );
  if (hideCompletedFoldersCheckbox) {
    hideCompletedFoldersCheckbox.checked = false;
    hideCompletedFoldersCheckbox.onchange = () => applyScanFileFilter();
  }

  hideEl('folder-browser-panel');
  showEl('scan-results-section');
}

/**
 * Green checkmark SVG for fully-uploaded folders.
 * @returns {string}
 */
function checkmarkIcon() {
  return '<svg class="h-4 w-4 text-green-500 inline-block ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>';
}

/**
 * Start a background cache-only scan for the current folder to enrich
 * folder rows with upload status. Called automatically after navigation.
 * @param {string} folderPath
 */
async function startBrowserScan(folderPath) {
  // Cancel any existing browser scan
  if (state.browserScanJobId) {
    try {
      await apiPost(`/api/upload/cancel/${state.browserScanJobId}`);
    } catch (_error) {
      // Scan may have already finished
    }
  }
  if (state.browserScanEventSource) {
    state.browserScanEventSource.close();
    state.browserScanEventSource = null;
  }

  // Reset browser scan state
  state.browserScanResults = [];
  state.browserScanJobId = null;
  state.browserScanComplete = false;
  state.scanFileStatuses = [];
  state.scanFilePaths = [];
  state.scanTotalSize = 0;

  // Running aggregation map: immediate child folder name → { totalFiles, alreadyUploaded }
  /** @type {Map<string, { totalFiles: number, alreadyUploaded: number }>} */
  const folderAggregation = new Map();

  // Root file aggregation (for files in the browsed folder itself)
  let rootTotalFiles = 0;
  let rootAlreadyUploaded = 0;

  // Disable Upload button until scan completes
  const selectBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('select-folder-btn')
  );
  if (selectBtn) {
    selectBtn.disabled = true;
    const btnSpan = selectBtn.querySelector('span');
    if (btnSpan) btnSpan.textContent = 'Scanning...';
  }

  // Show scan status bar
  showEl('browser-scan-status');
  const spinner = document.getElementById('browser-scan-spinner');
  if (spinner) spinner.classList.remove('hidden');
  setText('browser-scan-text', 'Scanning folders...');

  // Wire up hide-uploaded toggle
  const hideCheckbox = /** @type {HTMLInputElement | null} */ (
    document.getElementById('browser-hide-uploaded')
  );
  if (hideCheckbox) {
    hideCheckbox.onchange = () => applyBrowserHideUploaded(hideCheckbox.checked);
  }

  try {
    const data = await apiPost('/api/upload/scan-folder-async', {
      folder_path: folderPath,
      cache_only: true,
    });

    state.browserScanJobId = data.job_id;

    // Connect SSE for browser scan progress
    state.browserScanEventSource = new EventSource(`/api/upload/progress/${data.job_id}`);

    state.browserScanEventSource.onmessage = (event) => {
      const eventData = JSON.parse(event.data);

      if (eventData.error) {
        showNotification(eventData.error, 'error');
        closeBrowserScan();
        enableUploadButton(folderPath);
        return;
      }

      if (eventData.type === 'scan_started') {
        setText('browser-scan-text', `Scanning 0 of ${eventData.folders_total} folders...`);
      }

      if (eventData.type === 'scan_folder_complete') {
        const folder = eventData.folder;
        const totals = eventData.running_totals;

        // Store result
        state.browserScanResults.push(folder);
        state.scanTotalSize = totals.total_size;

        // Accumulate file statuses and paths
        for (const file of folder.files) {
          state.scanFileStatuses.push(file);
          if (!file.already_uploaded) {
            state.scanFilePaths.push(file.path);
          }
        }

        // Determine which immediate child this leaf folder belongs to
        if (folder.relative_path === '.') {
          // Root folder files
          rootTotalFiles += folder.total_files;
          rootAlreadyUploaded += folder.already_uploaded;
          updateRootUploadStatus(rootTotalFiles, rootAlreadyUploaded);
        } else {
          // Extract the first path component
          const firstSlash = folder.relative_path.indexOf('/');
          const immediateChild =
            firstSlash >= 0 ? folder.relative_path.substring(0, firstSlash) : folder.relative_path;

          const existing = folderAggregation.get(immediateChild) || {
            totalFiles: 0,
            alreadyUploaded: 0,
          };
          existing.totalFiles += folder.total_files;
          existing.alreadyUploaded += folder.already_uploaded;
          folderAggregation.set(immediateChild, existing);

          // Update the matching folder row in the browser
          updateFolderRowBadge(immediateChild, existing);
        }

        // Update status bar
        setText(
          'browser-scan-text',
          `Scanning ${eventData.folders_scanned} of ${eventData.folders_total} folders...`,
        );

        // Update Upload button summary
        updateUploadButtonSummary();
      }

      if (eventData.type === 'scan_complete') {
        closeBrowserScan();
        state.browserScanComplete = true;

        // Hide spinner, show final status
        if (spinner) spinner.classList.add('hidden');

        const totalFiles = state.scanFileStatuses.length;
        const alreadyUploaded = state.scanFileStatuses.filter(
          (/** @type {any} */ f) => f.already_uploaded,
        ).length;
        const toUpload = totalFiles - alreadyUploaded;

        if (totalFiles === 0) {
          setText('browser-scan-text', 'No MCAP files found in subfolders.');
          enableUploadButton(folderPath);
        } else if (toUpload === 0) {
          setText('browser-scan-text', `All ${totalFiles} files already uploaded.`);
          enableUploadButton(folderPath, true);
        } else {
          setText(
            'browser-scan-text',
            `Scan complete: ${toUpload} to upload, ${alreadyUploaded} already uploaded.`,
          );
          enableUploadButton(folderPath);
        }
      }
    };

    state.browserScanEventSource.onerror = () => {
      closeBrowserScan();
      enableUploadButton(folderPath);
    };
  } catch (error) {
    showNotification(/** @type {Error} */ (error).message, 'error');
    closeBrowserScan();
    enableUploadButton(folderPath);
  }
}

/**
 * Close the browser scan SSE connection.
 */
function closeBrowserScan() {
  if (state.browserScanEventSource) {
    state.browserScanEventSource.close();
    state.browserScanEventSource = null;
  }
}

/**
 * Re-enable the Upload button after scan completes.
 * @param {string} folderPath
 * @param {boolean} [allUploaded] - If true, keep button disabled (nothing to upload)
 */
function enableUploadButton(folderPath, allUploaded = false) {
  const selectBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('select-folder-btn')
  );
  if (!selectBtn) return;

  if (allUploaded) {
    selectBtn.disabled = true;
    const btnSpan = selectBtn.querySelector('span');
    if (btnSpan) btnSpan.textContent = 'All Files Uploaded';
  } else {
    selectBtn.disabled = false;
    selectBtn.dataset.path = folderPath;
    updateUploadButtonSummary();
  }
}

/**
 * Update the Upload button label and summary text based on scan data.
 */
function updateUploadButtonSummary() {
  const toUploadCount = state.scanFilePaths.length;
  const totalCount = state.scanFileStatuses.length;
  const uploadedCount = totalCount - toUploadCount;

  const selectBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('select-folder-btn')
  );
  if (selectBtn) {
    const btnSpan = selectBtn.querySelector('span');
    if (btnSpan) {
      if (toUploadCount > 0) {
        btnSpan.textContent = `Upload ${toUploadCount} Files`;
      } else if (totalCount > 0) {
        btnSpan.textContent = 'All Files Uploaded';
      } else {
        btnSpan.textContent = 'Upload This Folder';
      }
    }
  }

  // Update bottom summary text
  if (totalCount > 0) {
    const sizeToUpload = state.scanFileStatuses
      .filter((/** @type {any} */ f) => !f.already_uploaded)
      .reduce((/** @type {number} */ sum, /** @type {any} */ f) => sum + f.size, 0);
    if (toUploadCount > 0) {
      setText(
        'folder-select-summary',
        `${toUploadCount} of ${totalCount} files to upload (${formatBytes(sizeToUpload)}). ${uploadedCount} already uploaded.`,
      );
    } else {
      setText('folder-select-summary', `All ${totalCount} files are already uploaded.`);
    }
  }
}

/**
 * Update a folder row's badge with scan results.
 * @param {string} folderName
 * @param {{ totalFiles: number, alreadyUploaded: number }} stats
 */
function updateFolderRowBadge(folderName, stats) {
  const folderList = document.getElementById('folder-list');
  if (!folderList) return;

  const row = folderList.querySelector(`[data-folder-name="${CSS.escape(folderName)}"]`);
  if (!row) return;

  const badge = row.querySelector('.folder-mcap-badge');
  if (!badge) return;

  const allUploaded = stats.alreadyUploaded === stats.totalFiles && stats.totalFiles > 0;

  if (allUploaded) {
    badge.innerHTML = `${stats.totalFiles} mcap (${stats.alreadyUploaded} uploaded) ${checkmarkIcon()}`;
    row.classList.add('bg-green-50');
    /** @type {HTMLElement} */ (row).dataset.allUploaded = 'true';
  } else if (stats.alreadyUploaded > 0) {
    badge.textContent = `${stats.totalFiles} mcap (${stats.alreadyUploaded} uploaded)`;
  } else {
    badge.textContent = `${stats.totalFiles} mcap`;
  }
}

/**
 * Update the root upload status in the MCAP count info bar.
 * @param {number} totalFiles
 * @param {number} alreadyUploaded
 */
function updateRootUploadStatus(totalFiles, alreadyUploaded) {
  const statusEl = document.getElementById('browser-root-upload-status');
  if (!statusEl) return;

  if (alreadyUploaded === totalFiles && totalFiles > 0) {
    statusEl.innerHTML = `<span class="text-green-600">(${alreadyUploaded} uploaded) ${checkmarkIcon()}</span>`;
  } else if (alreadyUploaded > 0) {
    statusEl.innerHTML = `<span class="text-gray-600">(${alreadyUploaded} of ${totalFiles} uploaded)</span>`;
  }
}

/**
 * Toggle visibility of fully-uploaded folder rows in the browser.
 * @param {boolean} hide
 */
function applyBrowserHideUploaded(hide) {
  const folderList = document.getElementById('folder-list');
  if (!folderList) return;

  const rows = folderList.querySelectorAll('[data-folder-name]');
  for (const row of rows) {
    if (hide && /** @type {HTMLElement} */ (row).dataset.allUploaded === 'true') {
      /** @type {HTMLElement} */ (row).classList.add('hidden');
    } else {
      /** @type {HTMLElement} */ (row).classList.remove('hidden');
    }
  }
}

/**
 * Append a scanned folder as a collapsed summary row in the review table.
 * File rows are only rendered on-demand when the folder header is expanded.
 * @param {{ relative_path: string, files: any[], total_files: number, already_uploaded: number, all_uploaded: boolean, error: string | null }} folderData
 * @param {number} folderIndex - Index into state.browserScanResults
 */
function appendFolderToReviewTable(folderData, folderIndex) {
  const tbody = document.getElementById('scan-file-list');
  if (!tbody) return;

  const folderLabel = folderData.relative_path === '.' ? '(root)' : folderData.relative_path;
  const toUpload = folderData.total_files - folderData.already_uploaded;

  // Collapsed folder header only — no file rows (rendered on expand)
  const headerHtml = `
    <tr class="bg-gray-100 cursor-pointer hover:bg-gray-200 select-none ${folderData.all_uploaded ? 'folder-all-uploaded' : ''}"
        data-folder-header
        data-folder-idx="${folderIndex}"
        data-all-uploaded="${folderData.all_uploaded}"
        data-expanded="false">
      <td colspan="5" class="px-4 py-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center">
            <svg class="folder-chevron h-4 w-4 text-gray-400 mr-2 transition-transform flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
            ${folderIcon('h-4 w-4 text-nlr-yellow mr-2')}
            <span class="text-sm font-medium text-gray-700">${folderLabel}</span>
            ${folderData.all_uploaded ? checkmarkIcon() : ''}
          </div>
          <div class="flex items-center space-x-3">
            <span class="text-xs text-gray-600">${folderData.total_files} files</span>
            ${toUpload > 0 ? `<span class="text-xs font-medium text-green-700">${toUpload} to upload</span>` : ''}
            ${folderData.already_uploaded > 0 ? `<span class="text-xs text-gray-500">${folderData.already_uploaded} uploaded</span>` : ''}
            ${folderData.error ? `<span class="text-xs text-red-600 bg-red-100 px-2 py-0.5 rounded-full">Error</span>` : ''}
          </div>
        </div>
      </td>
    </tr>
  `;

  tbody.insertAdjacentHTML('beforeend', headerHtml);
  applyScanFileFilter();
}

/**
 * Toggle expand/collapse of a folder in the review table.
 * @param {HTMLTableRowElement} headerRow
 */
function toggleFolderExpand(headerRow) {
  const idx = Number.parseInt(headerRow.dataset.folderIdx || '0', 10);
  const folderData = state.browserScanResults[idx];
  if (!folderData) return;

  const isExpanded = headerRow.dataset.expanded === 'true';
  const chevron = headerRow.querySelector('.folder-chevron');

  if (isExpanded) {
    // Collapse: remove file rows after this header until next header
    let next = headerRow.nextElementSibling;
    while (next && !next.hasAttribute('data-folder-header')) {
      const toRemove = next;
      next = next.nextElementSibling;
      toRemove.remove();
    }
    headerRow.dataset.expanded = 'false';
    if (chevron) chevron.classList.remove('rotate-90');
  } else {
    // Expand: render file rows after this header using a DocumentFragment
    const fragment = document.createDocumentFragment();
    for (const file of folderData.files) {
      const tr = document.createElement('tr');
      tr.className = file.already_uploaded ? 'bg-yellow-50' : '';
      tr.dataset.alreadyUploaded = String(file.already_uploaded);
      const dirPath = getDirectoryPart(file.relative_path);
      tr.innerHTML = `
        <td class="pl-8 pr-4 py-3">
          <span class="text-sm ${file.already_uploaded ? 'text-gray-500' : 'text-gray-900'} truncate block" title="${file.filename}">${file.filename}</span>
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
      `;
      fragment.appendChild(tr);
    }
    headerRow.after(fragment);
    headerRow.dataset.expanded = 'true';
    if (chevron) chevron.classList.add('rotate-90');
  }
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

function applyScanFileFilter() {
  const hideUploadedEl = /** @type {HTMLInputElement | null} */ (
    document.getElementById('scan-hide-uploaded')
  );
  const hideUploaded = hideUploadedEl?.checked || false;

  const hideCompletedFoldersEl = /** @type {HTMLInputElement | null} */ (
    document.getElementById('scan-hide-completed-folders')
  );
  const hideCompletedFolders = hideCompletedFoldersEl?.checked || false;

  const tbody = document.getElementById('scan-file-list');
  if (!tbody) return;

  // Determine which folder headers are for completed folders
  /** @type {Set<Element>} */
  const hiddenFolderHeaders = new Set();

  // First pass: process folder headers
  const folderHeaders = tbody.querySelectorAll('[data-folder-header]');
  for (const header of folderHeaders) {
    if (
      hideCompletedFolders &&
      /** @type {HTMLElement} */ (header).dataset.allUploaded === 'true'
    ) {
      header.classList.add('hidden');
      hiddenFolderHeaders.add(header);
    } else {
      header.classList.remove('hidden');
    }
  }

  // Second pass: process file rows
  // For each file row, find its parent folder header (the nearest preceding [data-folder-header])
  const allRows = /** @type {NodeListOf<HTMLElement>} */ (tbody.querySelectorAll('tr'));
  /** @type {Element | null} */
  let currentFolderHeader = null;

  for (const row of allRows) {
    if (row.hasAttribute('data-folder-header')) {
      currentFolderHeader = row;
      continue;
    }

    // This is a file row
    const isUploaded = row.dataset.alreadyUploaded === 'true';
    const inHiddenFolder = currentFolderHeader && hiddenFolderHeaders.has(currentFolderHeader);

    if (inHiddenFolder || (hideUploaded && isUploaded)) {
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
 * Initialize the upload view for a new job.
 * Instead of creating 20K+ DOM rows, initialize status counters and
 * clear the active upload area. Active files render on-demand.
 * @param {string[]} filePaths
 */
function initUploadFileList(filePaths) {
  const activeList = document.getElementById('upload-active-list');
  if (activeList) activeList.innerHTML = '';

  // Initialize counters (all files start as "pending")
  initStatusCounts(filePaths.length);
  setText('files-total', String(filePaths.length));
}
