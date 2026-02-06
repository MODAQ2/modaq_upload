/**
 * File analysis/validation (Step 3) and handleFiles entry point.
 */
import state from './state.js';
import { STEP_3_VALIDATED, setUploadStep, showUploadSteps } from './stepper.js';
import { resetUpload } from './upload-control.js';
import { connectProgressStream, showCompletionSummary, updateProgressUI } from './upload-exec.js';
import { formatBytes, showNotification } from './utils.js';

/**
 * Check for an active upload job and restore UI state.
 */
export async function checkForActiveJob() {
  try {
    const response = await fetch('/api/upload/active');
    if (!response.ok) return;

    const data = await response.json();
    if (!data.job_id) return;

    state.currentJobId = data.job_id;
    const job = data.job;

    if (job.status === 'analyzing') {
      setUploadStep(3);
      document.getElementById('drop-zone')?.classList.add('hidden');
      document.getElementById('analysis-section')?.classList.remove('hidden');
      initializeAnalysisTableFromJob(job);
      connectAnalysisProgressStream(state.currentJobId);
    } else if (job.status === 'ready') {
      setUploadStep(3);
      document.getElementById('drop-zone')?.classList.add('hidden');
      document.getElementById('analysis-section')?.classList.remove('hidden');
      displayAnalysisResults(job);
    } else if (job.status === 'uploading') {
      setUploadStep(4);
      document.getElementById('drop-zone')?.classList.add('hidden');
      document.getElementById('progress-section')?.classList.remove('hidden');
      connectProgressStream();
    } else if (
      job.status === 'completed' ||
      job.status === 'failed' ||
      job.status === 'cancelled'
    ) {
      setUploadStep(5);
      document.getElementById('drop-zone')?.classList.add('hidden');
      document.getElementById('completion-section')?.classList.remove('hidden');
      showCompletionSummary(job);
    }
  } catch (error) {
    console.log('No active job found:', /** @type {Error} */ (error).message);
  }
}

/**
 * Initialize analysis table from an existing job (for state restoration).
 * @param {any} job
 */
function initializeAnalysisTableFromJob(job) {
  const tbody = document.getElementById('file-table-body');
  if (!tbody) return;

  tbody.innerHTML = job.files
    .map((/** @type {any} */ file) => {
      let statusBadge;
      if (file.status === 'analyzing') {
        statusBadge = `<span class="px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-800 inline-flex items-center">
                <svg class="spinner h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Analyzing
            </span>`;
      } else if (file.status === 'failed') {
        statusBadge =
          '<span class="px-2 py-1 text-xs rounded-full bg-red-100 text-red-800">Failed</span>';
      } else if (file.is_duplicate) {
        statusBadge =
          '<span class="px-2 py-1 text-xs rounded-full bg-yellow-100 text-yellow-800">Duplicate</span>';
      } else {
        statusBadge =
          '<span class="px-2 py-1 text-xs rounded-full bg-green-100 text-green-800">Ready</span>';
      }

      const startTimeDisplay = file.start_time
        ? new Date(file.start_time).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '-';

      return `
            <tr class="file-item" data-filename="${file.filename}" data-is-analyzed="${file.status !== 'analyzing'}" data-is-duplicate="${file.is_duplicate || false}">
                <td class="px-4 py-3">
                    <div class="flex items-center min-w-0">
                        <svg class="h-5 w-5 text-gray-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <span class="text-sm font-medium text-gray-900 truncate" title="${file.filename}">${file.filename}</span>
                    </div>
                </td>
                <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-500">${file.file_size_formatted || '-'}</td>
                <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-500">${startTimeDisplay}</td>
                <td class="px-4 py-3 text-sm text-gray-500 truncate">${file.s3_path || '-'}</td>
                <td class="px-4 py-3 whitespace-nowrap">${statusBadge}</td>
            </tr>
        `;
    })
    .join('');

  const totalFiles = document.getElementById('total-files');
  if (totalFiles) totalFiles.textContent = String(job.files.length);

  const uploadBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('upload-btn'));
  if (uploadBtn) uploadBtn.disabled = true;
}

/**
 * Handle files from drag-drop or file input.
 * @param {File[]} files
 */
export async function handleFiles(files) {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }

  showUploadSteps(3);

  document.getElementById('drop-zone')?.classList.add('hidden');
  document.getElementById('analysis-section')?.classList.remove('hidden');

  initializeAnalysisTable(files);

  try {
    const response = await fetch('/api/upload/analyze', {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();

    if (!response.ok && response.status !== 202) {
      throw new Error(data.error || 'Analysis failed');
    }

    state.currentJobId = data.job_id;

    if (response.status === 202) {
      connectAnalysisProgressStream(data.job_id);
    } else {
      displayAnalysisResults(data);
    }
  } catch (error) {
    showNotification(/** @type {Error} */ (error).message, 'error');
    resetUpload();
  }
}

/**
 * Initialize the analysis table with placeholder rows.
 * @param {File[]} files
 */
function initializeAnalysisTable(files) {
  const tbody = document.getElementById('file-table-body');
  if (!tbody) return;

  tbody.innerHTML = files
    .map(
      (file) => `
        <tr class="file-item" data-filename="${file.name}" data-is-analyzed="false" data-is-duplicate="false">
            <td class="px-4 py-3">
                <div class="flex items-center min-w-0">
                    <svg class="h-5 w-5 text-gray-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span class="text-sm font-medium text-gray-900 truncate" title="${file.name}">${file.name}</span>
                </div>
            </td>
            <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-500">${formatBytes(file.size)}</td>
            <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-500">-</td>
            <td class="px-4 py-3 text-sm text-gray-500 truncate">-</td>
            <td class="px-4 py-3 whitespace-nowrap">
                <span class="px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-800 inline-flex items-center">
                    <svg class="spinner h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Analyzing
                </span>
            </td>
        </tr>
    `,
    )
    .join('');

  const totalFiles = document.getElementById('total-files');
  if (totalFiles) totalFiles.textContent = String(files.length);

  const totalSize = document.getElementById('total-size');
  if (totalSize) totalSize.textContent = formatBytes(files.reduce((sum, f) => sum + f.size, 0));

  const duplicateCount = document.getElementById('duplicate-count');
  if (duplicateCount) duplicateCount.textContent = '0';

  const uploadBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('upload-btn'));
  if (uploadBtn) uploadBtn.disabled = true;

  const analysisCompleted = document.getElementById('analysis-completed');
  if (analysisCompleted) analysisCompleted.textContent = '0';

  const analysisTotal = document.getElementById('analysis-total');
  if (analysisTotal) analysisTotal.textContent = String(files.length);

  const analysisPercent = document.getElementById('analysis-percent');
  if (analysisPercent) analysisPercent.textContent = '0%';

  const analysisProgressBar = /** @type {HTMLElement | null} */ (
    document.getElementById('analysis-progress-bar')
  );
  if (analysisProgressBar) analysisProgressBar.style.width = '0%';

  document.getElementById('analysis-progress')?.classList.remove('hidden');
}

/**
 * Initialize analysis table from file paths (folder upload).
 * @param {string[]} filePaths
 */
export function initializeAnalysisTableFromPaths(filePaths) {
  const tbody = document.getElementById('file-table-body');
  if (!tbody) return;

  tbody.innerHTML = filePaths
    .map((path) => {
      const filename = path.split('/').pop();
      return `
            <tr class="file-item" data-filename="${filename}" data-is-analyzed="false" data-is-duplicate="false">
                <td class="px-4 py-3">
                    <div class="flex items-center min-w-0">
                        <svg class="h-5 w-5 text-gray-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <span class="text-sm font-medium text-gray-900 truncate" title="${filename}">${filename}</span>
                    </div>
                </td>
                <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-500">-</td>
                <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-500">-</td>
                <td class="px-4 py-3 text-sm text-gray-500 truncate">-</td>
                <td class="px-4 py-3 whitespace-nowrap">
                    <span class="px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-800 inline-flex items-center">
                        <svg class="spinner h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Analyzing
                    </span>
                </td>
            </tr>
        `;
    })
    .join('');

  const totalFiles = document.getElementById('total-files');
  if (totalFiles) totalFiles.textContent = String(filePaths.length);

  const totalSize = document.getElementById('total-size');
  if (totalSize) totalSize.textContent = '-';

  const duplicateCount = document.getElementById('duplicate-count');
  if (duplicateCount) duplicateCount.textContent = '0';

  const uploadBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('upload-btn'));
  if (uploadBtn) uploadBtn.disabled = true;

  const analysisCompleted = document.getElementById('analysis-completed');
  if (analysisCompleted) analysisCompleted.textContent = '0';

  const analysisTotal = document.getElementById('analysis-total');
  if (analysisTotal) analysisTotal.textContent = String(filePaths.length);

  const analysisPercent = document.getElementById('analysis-percent');
  if (analysisPercent) analysisPercent.textContent = '0%';

  const analysisProgressBar = /** @type {HTMLElement | null} */ (
    document.getElementById('analysis-progress-bar')
  );
  if (analysisProgressBar) analysisProgressBar.style.width = '0%';

  document.getElementById('analysis-progress')?.classList.remove('hidden');
}

/**
 * Connect to SSE stream for analysis progress updates.
 * @param {string | null} jobId
 */
export function connectAnalysisProgressStream(jobId) {
  if (state.eventSource) {
    state.eventSource.close();
  }

  state.eventSource = new EventSource(`/api/upload/progress/${jobId}`);

  state.eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.error) {
      showNotification(data.error, 'error');
      state.eventSource?.close();
      return;
    }

    if (data.type === 'analysis_progress') {
      updateAnalysisRow(data.file);
    }

    if (data.type === 'analysis_complete') {
      displayAnalysisResults(data.job);

      if (!data.auto_upload) {
        state.eventSource?.close();
        state.eventSource = null;
      }
    }

    if (data.type === 'auto_upload_starting') {
      showNotification('Auto-upload starting...', 'info');
      setUploadStep(4);
      document.getElementById('analysis-section')?.classList.add('hidden');
      document.getElementById('progress-section')?.classList.remove('hidden');
    }

    if (!data.type && data.job_id && data.status) {
      if (data.status === 'uploading') {
        updateProgressUI(data);
      } else if (['completed', 'failed', 'cancelled'].includes(data.status)) {
        state.eventSource?.close();
        state.eventSource = null;
        showCompletionSummary(data);
      } else if (data.status === 'ready') {
        displayAnalysisResults(data);
      }
    }
  };

  state.eventSource.onerror = () => {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
      showNotification('Connection to server lost', 'error');
    }
  };
}

/**
 * Update a single row in the analysis table.
 * @param {any} fileData
 */
function updateAnalysisRow(fileData) {
  const row = /** @type {HTMLTableRowElement | null} */ (
    document.querySelector(`tr[data-filename="${fileData.filename}"]`)
  );
  if (!row) return;

  let statusBadge;
  if (fileData.status === 'failed') {
    statusBadge = `<span class="px-2 py-1 text-xs rounded-full bg-red-100 text-red-800" title="${fileData.error_message || ''}">Failed</span>`;
  } else if (fileData.is_duplicate) {
    statusBadge =
      '<span class="px-2 py-1 text-xs rounded-full bg-yellow-100 text-yellow-800">Duplicate</span>';
  } else if (fileData.is_valid === false) {
    statusBadge =
      '<span class="px-2 py-1 text-xs rounded-full bg-orange-100 text-orange-800" title="Invalid timestamp (pre-1980)">Invalid</span>';
  } else if (fileData.status === 'ready') {
    statusBadge =
      '<span class="px-2 py-1 text-xs rounded-full bg-green-100 text-green-800">Ready</span>';
  } else {
    statusBadge = `<span class="px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-800 inline-flex items-center">
            <svg class="spinner h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Analyzing
        </span>`;
  }

  row.dataset.status = fileData.status;
  row.dataset.isDuplicate = fileData.is_duplicate ? 'true' : 'false';
  row.dataset.isAnalyzed =
    fileData.status === 'ready' || fileData.status === 'failed' ? 'true' : 'false';

  const startTimeDisplay = fileData.start_time
    ? new Date(fileData.start_time).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '-';

  row.innerHTML = `
        <td class="px-4 py-3">
            <div class="flex items-center min-w-0">
                <svg class="h-5 w-5 text-gray-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span class="text-sm font-medium text-gray-900 truncate" title="${fileData.filename}">${fileData.filename}</span>
            </div>
        </td>
        <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-500">${fileData.file_size_formatted}</td>
        <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-500" title="${fileData.start_time || ''}">${startTimeDisplay}</td>
        <td class="px-4 py-3 text-sm text-gray-500 truncate" title="${fileData.s3_path || ''}">${fileData.s3_path || '-'}</td>
        <td class="px-4 py-3 whitespace-nowrap">${statusBadge}</td>
    `;

  updateAnalysisProgress();
  updateAnalysisSummary();
  applyUploadedFilter();
}

function updateAnalysisSummary() {
  const rows = document.querySelectorAll('#file-table-body tr[data-filename]');
  let duplicateCount = 0;

  for (const row of rows) {
    const badge = row.querySelector('td:last-child span');
    if (badge?.textContent?.includes('Duplicate')) {
      duplicateCount++;
    }
  }

  const el = document.getElementById('duplicate-count');
  if (el) el.textContent = String(duplicateCount);
}

function updateAnalysisProgress() {
  const rows = document.querySelectorAll('#file-table-body tr[data-filename]');
  const total = rows.length;
  let analyzed = 0;

  for (const row of rows) {
    if (/** @type {HTMLElement} */ (row).dataset.isAnalyzed === 'true') {
      analyzed++;
    }
  }

  const percent = total > 0 ? Math.round((analyzed / total) * 100) : 0;

  const analysisCompleted = document.getElementById('analysis-completed');
  if (analysisCompleted) analysisCompleted.textContent = String(analyzed);

  const analysisTotal = document.getElementById('analysis-total');
  if (analysisTotal) analysisTotal.textContent = String(total);

  const analysisPercent = document.getElementById('analysis-percent');
  if (analysisPercent) analysisPercent.textContent = `${percent}%`;

  const analysisProgressBar = /** @type {HTMLElement | null} */ (
    document.getElementById('analysis-progress-bar')
  );
  if (analysisProgressBar) analysisProgressBar.style.width = `${percent}%`;

  const progressSection = document.getElementById('analysis-progress');
  if (analyzed === total && total > 0) {
    progressSection?.classList.add('hidden');
  } else {
    progressSection?.classList.remove('hidden');
  }
}

export function applyUploadedFilter() {
  const hideUploadedEl = /** @type {HTMLInputElement | null} */ (
    document.getElementById('hide-uploaded')
  );
  const hideUploaded = hideUploadedEl?.checked || false;
  const rows = document.querySelectorAll('#file-table-body tr[data-filename]');

  for (const row of rows) {
    if (hideUploaded && /** @type {HTMLElement} */ (row).dataset.isDuplicate === 'true') {
      row.classList.add('hidden');
    } else {
      row.classList.remove('hidden');
    }
  }
}

/**
 * Display final analysis results.
 * @param {any} job
 */
export function displayAnalysisResults(job) {
  const tbody = document.getElementById('file-table-body');
  if (!tbody) return;

  let totalSize = 0;
  let duplicateCount = 0;
  let invalidCount = 0;

  tbody.innerHTML = job.files
    .map((/** @type {any} */ file) => {
      totalSize += file.file_size;
      if (file.is_duplicate) duplicateCount++;
      if (file.is_valid === false) invalidCount++;

      let statusBadge;
      if (file.status === 'failed') {
        statusBadge = `<span class="px-2 py-1 text-xs rounded-full bg-red-100 text-red-800" title="${file.error_message}">Failed</span>`;
      } else if (file.is_duplicate) {
        statusBadge =
          '<span class="px-2 py-1 text-xs rounded-full bg-yellow-100 text-yellow-800">Duplicate</span>';
      } else if (file.is_valid === false) {
        statusBadge =
          '<span class="px-2 py-1 text-xs rounded-full bg-orange-100 text-orange-800" title="Invalid timestamp (pre-1980)">Invalid</span>';
      } else {
        statusBadge =
          '<span class="px-2 py-1 text-xs rounded-full bg-green-100 text-green-800">Ready</span>';
      }

      const startTimeDisplay = file.start_time
        ? new Date(file.start_time).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '-';

      return `
            <tr class="file-item" data-filename="${file.filename}"
                data-status="${file.status}"
                data-is-duplicate="${file.is_duplicate ? 'true' : 'false'}"
                data-is-analyzed="true">
                <td class="px-4 py-3">
                    <div class="flex items-center min-w-0">
                        <svg class="h-5 w-5 text-gray-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <span class="text-sm font-medium text-gray-900 truncate" title="${file.filename}">${file.filename}</span>
                    </div>
                </td>
                <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-500">${file.file_size_formatted}</td>
                <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-500" title="${file.start_time || ''}">${startTimeDisplay}</td>
                <td class="px-4 py-3 text-sm text-gray-500 truncate" title="${file.s3_path || ''}">${file.s3_path || '-'}</td>
                <td class="px-4 py-3 whitespace-nowrap">${statusBadge}</td>
            </tr>
        `;
    })
    .join('');

  const totalFilesEl = document.getElementById('total-files');
  if (totalFilesEl) totalFilesEl.textContent = String(job.files.length);

  const totalSizeEl = document.getElementById('total-size');
  if (totalSizeEl) totalSizeEl.textContent = formatBytes(totalSize);

  const duplicateCountEl = document.getElementById('duplicate-count');
  if (duplicateCountEl) {
    duplicateCountEl.textContent =
      String(duplicateCount) + (invalidCount > 0 ? ` + ${invalidCount} invalid` : '');
  }

  document.getElementById('analysis-progress')?.classList.add('hidden');

  const hasUploadableFiles = job.files.some(
    (/** @type {any} */ f) => f.status === 'ready' && f.is_valid !== false && !f.is_duplicate,
  );
  const uploadBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('upload-btn'));
  if (uploadBtn) uploadBtn.disabled = !hasUploadableFiles;

  const descriptionEl = document.getElementById('step-description');
  if (descriptionEl) {
    descriptionEl.textContent = STEP_3_VALIDATED;
  }

  applyUploadedFilter();
}
