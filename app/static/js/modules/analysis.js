/**
 * File analysis/validation and combined upload progress (Step 3).
 */
import { apiGet } from './api.js';
import { hideEl, setText, showEl } from './dom.js';
import { formatBytes } from './formatters.js';
import { showNotification } from './notify.js';
import state from './state.js';
import { setUploadStep } from './stepper.js';
import { showCompletionSummary, updateProgressUI } from './upload-exec.js';

// Progress weighting: analysis is typically slower than upload
const ANALYSIS_WEIGHT = 70;
const UPLOAD_WEIGHT = 30;

/**
 * Cache of last-known status per filename to avoid redundant DOM rebuilds.
 * @type {Map<string, string>}
 */
const fileRowStatusCache = new Map();

/** Pending file updates to flush in the next animation frame. @type {Map<string, any>} */
const pendingFileUpdates = new Map();

/** Whether a requestAnimationFrame is already scheduled. */
let rafScheduled = false;

/** Pending overall progress data to flush. @type {any} */
let pendingProgressData = null;

/** Current phase of the upload flow: 'analysis' or 'upload'. */
let currentPhase = 'analysis';

/**
 * Reset internal state (call when starting a new job or resetting).
 */
export function resetAnalysisState() {
  fileRowStatusCache.clear();
  pendingFileUpdates.clear();
  pendingProgressData = null;
  rafScheduled = false;
  currentPhase = 'analysis';
}

/**
 * Check for an active upload job and restore UI state.
 */
export async function checkForActiveJob() {
  try {
    const data = await apiGet('/api/upload/active');
    if (!data.job_id) return;

    state.currentJobId = data.job_id;
    const job = data.job;

    if (job.status === 'analyzing' || job.status === 'uploading') {
      setUploadStep(3);
      hideEl('folder-browser-panel');
      showEl('upload-section');

      if (job.status === 'uploading') {
        setText('upload-phase-label', 'Uploading files...');
      }

      connectCombinedProgressStream(state.currentJobId);
    } else if (job.status === 'ready') {
      setUploadStep(3);
      hideEl('folder-browser-panel');
      showEl('upload-section');
      connectCombinedProgressStream(state.currentJobId);
    } else if (
      job.status === 'completed' ||
      job.status === 'failed' ||
      job.status === 'cancelled'
    ) {
      setUploadStep(4);
      hideEl('folder-browser-panel');
      showEl('completion-section');
      showCompletionSummary(job);
    }
  } catch (error) {
    console.log('No active job found:', /** @type {Error} */ (error).message);
  }
}

/**
 * Connect to SSE stream for combined validation + upload progress.
 * @param {string | null} jobId
 */
export function connectCombinedProgressStream(jobId) {
  if (state.eventSource) {
    state.eventSource.close();
  }

  resetAnalysisState();

  state.eventSource = new EventSource(`/api/upload/progress/${jobId}`);

  let analysisTotal = 0;
  let analysisCompleted = 0;

  state.eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.error) {
      showNotification(data.error, 'error');
      state.eventSource?.close();
      return;
    }

    // Analysis progress: queue per-file update for next frame
    if (data.type === 'analysis_progress') {
      queueFileUpdate(data.file);

      // Set total from the first event that carries it
      if (data.total_files && analysisTotal === 0) {
        analysisTotal = data.total_files;
        setText('files-total', data.total_files);
      }

      // Only count terminal statuses for progress bar (not pending/analyzing)
      if (data.file.status !== 'pending' && data.file.status !== 'analyzing') {
        analysisCompleted++;
      }

      // Update progress bar for analysis phase (use float, let CSS transition smooth it)
      if (analysisTotal > 0) {
        const percent = (analysisCompleted / analysisTotal) * ANALYSIS_WEIGHT;
        setProgressBar(percent);
      }
    }

    // Analysis complete: transition to upload phase
    if (data.type === 'analysis_complete') {
      setProgressBar(ANALYSIS_WEIGHT);
      setPhaseLabel('Preparing upload...');

      if (!data.auto_upload) {
        state.eventSource?.close();
        state.eventSource = null;
      }
    }

    // Auto-upload starting
    if (data.type === 'auto_upload_starting') {
      currentPhase = 'upload';
      setPhaseLabel('Uploading files...');
    }

    // Upload progress updates (job-level data without a type field)
    if (!data.type && data.job_id && data.status) {
      if (data.status === 'uploading') {
        // Remap upload progress into the UPLOAD_WEIGHT portion of the bar
        const adjusted = {
          ...data,
          progress_percent: ANALYSIS_WEIGHT + (data.progress_percent / 100) * UPLOAD_WEIGHT,
        };
        pendingProgressData = adjusted;

        // Queue per-file row updates
        if (data.files) {
          for (const file of data.files) {
            queueFileUpdate(file);
          }
        }
        scheduleRaf();
      } else if (['completed', 'failed', 'cancelled'].includes(data.status)) {
        state.eventSource?.close();
        state.eventSource = null;
        showCompletionSummary(data);
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
 * Set the overall progress bar value (CSS transition handles smoothing).
 * @param {number} percent
 */
function setProgressBar(percent) {
  const progressBar = /** @type {HTMLElement | null} */ (document.getElementById('progress-bar'));
  if (progressBar) progressBar.style.width = `${percent}%`;
  setText('progress-percent', percent.toFixed(1));
}

/**
 * Update the phase label with an opacity fade transition.
 * @param {string} text
 */
function setPhaseLabel(text) {
  const phaseLabel = document.getElementById('upload-phase-label');
  if (!phaseLabel || phaseLabel.textContent === text) return;
  phaseLabel.style.opacity = '0';
  setTimeout(() => {
    phaseLabel.textContent = text;
    phaseLabel.style.opacity = '1';
  }, 150);
}

/**
 * Queue a file update for the next animation frame.
 * @param {any} fileData
 */
function queueFileUpdate(fileData) {
  pendingFileUpdates.set(fileData.filename, fileData);
  scheduleRaf();
}

/** Schedule a requestAnimationFrame if not already pending. */
function scheduleRaf() {
  if (!rafScheduled) {
    rafScheduled = true;
    requestAnimationFrame(flushUpdates);
  }
}

/** Flush all pending updates in a single animation frame. */
function flushUpdates() {
  rafScheduled = false;

  // Flush pending file row updates
  for (const [, fileData] of pendingFileUpdates) {
    updateUploadFileRow(fileData);
  }
  pendingFileUpdates.clear();

  // Recompute queue positions after row updates
  recomputeQueuePositions();

  // Flush pending overall progress
  if (pendingProgressData) {
    updateProgressUI(pendingProgressData);
    pendingProgressData = null;
  }
}

/**
 * Recompute "Queued (X of Y)" labels for pending/ready-queued files.
 */
function recomputeQueuePositions() {
  const allRows = document.querySelectorAll('[data-upload-file]');
  // Determine which statuses count as "queued" based on current phase
  const queuedStatuses = currentPhase === 'upload' ? ['ready'] : ['pending'];

  // First pass: count queued files
  let totalQueued = 0;
  for (const row of allRows) {
    const filename = /** @type {HTMLElement} */ (row).getAttribute('data-upload-file');
    const status = fileRowStatusCache.get(filename || '');
    if (status && queuedStatuses.includes(status)) {
      totalQueued++;
    }
  }

  if (totalQueued === 0) return;

  // Second pass: assign positions
  let pos = 1;
  for (const row of allRows) {
    const filename = /** @type {HTMLElement} */ (row).getAttribute('data-upload-file');
    const status = fileRowStatusCache.get(filename || '');
    if (status && queuedStatuses.includes(status)) {
      const label = row.querySelector('[data-queue-label]');
      if (label) {
        label.textContent =
          currentPhase === 'upload'
            ? `Queued for upload (${pos} of ${totalQueued})`
            : `Queued (${pos} of ${totalQueued})`;
      }
      pos++;
    }
  }
}

/**
 * Update a single file row with minimal DOM changes.
 * Only rebuilds innerHTML on status transitions; for uploading progress,
 * just updates the bar width and percentage text to avoid resetting spinners.
 * @param {any} fileData
 */
function updateUploadFileRow(fileData) {
  const row = document.querySelector(`[data-upload-file="${fileData.filename}"]`);
  if (!row) return;

  const cachedStatus = fileRowStatusCache.get(fileData.filename);
  const newStatus = fileData.is_duplicate ? `${fileData.status}:dup` : fileData.status;

  // If status hasn't changed, only do micro-updates for uploading progress
  if (cachedStatus === newStatus) {
    if (fileData.status === 'uploading') {
      const bar = /** @type {HTMLElement | null} */ (row.querySelector('[data-progress-bar]'));
      if (bar) bar.style.width = `${fileData.progress_percent || 0}%`;
      const label = row.querySelector('[data-progress-label]');
      if (label) {
        label.textContent =
          fileData.progress_percent != null ? `${fileData.progress_percent.toFixed(0)}%` : '';
      }
    }
    return;
  }

  // Status changed — full rebuild of the row
  fileRowStatusCache.set(fileData.filename, newStatus);
  row.innerHTML = buildFileRowHTML(fileData);
}

/**
 * Build the full HTML for a file row.
 * @param {any} fileData
 * @returns {string}
 */
function buildFileRowHTML(fileData) {
  let statusIcon = '';
  let statusText = '';

  if (fileData.status === 'completed') {
    statusIcon =
      '<svg class="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>';
    statusText = '<span class="text-xs text-green-600">Uploaded</span>';
  } else if (fileData.status === 'failed') {
    statusIcon =
      '<svg class="h-5 w-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>';
    statusText = `<span class="text-xs text-red-600" title="${fileData.error_message || ''}">Failed</span>`;
  } else if (fileData.status === 'skipped') {
    statusIcon =
      '<svg class="h-5 w-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 9l3 3m0 0l-3 3m3-3H8m13 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>';
    statusText = '<span class="text-xs text-yellow-600">Skipped</span>';
  } else if (fileData.status === 'uploading') {
    statusIcon =
      '<svg class="spinner h-5 w-5 text-nlr-blue" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';
    const pct = fileData.progress_percent != null ? `${fileData.progress_percent.toFixed(0)}%` : '';
    statusText = `
      <div class="flex items-center space-x-2">
        <div class="w-16 bg-gray-200 rounded-full h-2">
          <div data-progress-bar class="bg-nlr-blue h-2 rounded-full transition-[width] duration-300 ease-out" style="width: ${fileData.progress_percent || 0}%"></div>
        </div>
        <span data-progress-label class="text-xs text-gray-500 w-8">${pct}</span>
      </div>`;
  } else if (fileData.status === 'analyzing') {
    statusIcon =
      '<svg class="spinner h-5 w-5 text-blue-500" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';
    statusText = '<span class="text-xs text-blue-600">Validating</span>';
  } else if (fileData.status === 'ready') {
    if (fileData.is_duplicate) {
      statusIcon =
        '<svg class="h-5 w-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>';
      statusText = '<span class="text-xs text-yellow-600">Duplicate</span>';
    } else if (currentPhase === 'upload') {
      // In upload phase, non-duplicate ready files are queued for upload
      statusIcon =
        '<div class="h-5 w-5 text-gray-400"><svg class="h-5 w-5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div>';
      statusText = '<span data-queue-label class="text-xs text-gray-500">Queued for upload</span>';
    } else {
      statusIcon =
        '<svg class="h-5 w-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4" /></svg>';
      statusText = '<span class="text-xs text-green-600">Validated</span>';
    }
  } else if (fileData.status === 'pending') {
    statusIcon =
      '<div class="h-5 w-5 text-gray-400"><svg class="h-5 w-5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div>';
    statusText = '<span data-queue-label class="text-xs text-gray-500">Queued</span>';
  } else {
    statusText = `<span class="text-xs text-gray-400">${fileData.status || 'Unknown'}</span>`;
  }

  return `
    <div class="flex items-center space-x-3">
        ${statusIcon || '<div class="h-5 w-5"></div>'}
        <span class="text-sm text-gray-900">${fileData.filename}</span>
    </div>
    <div class="flex items-center space-x-4">
        ${fileData.file_size_formatted ? `<span class="text-sm text-gray-500">${fileData.file_size_formatted}</span>` : ''}
        ${statusText}
    </div>
  `;
}

/**
 * @param {any} fileData
 * @returns {string}
 */
export function formatFileSize(fileData) {
  return fileData.file_size_formatted || formatBytes(fileData.file_size || 0);
}
