/**
 * File analysis/validation and combined upload progress (Step 3).
 *
 * Performance: Instead of creating one DOM row per file (20K+ rows),
 * we track status in a Map and only render active uploads (max ~4-8 rows).
 * Status counters are maintained via simple arithmetic, not DOM scans.
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
 * Cache of last-known status per filename.
 * @type {Map<string, string>}
 */
const fileRowStatusCache = new Map();

/** Pending file updates to flush in the next animation frame. @type {Map<string, any>} */
const pendingFileUpdates = new Map();

/** Whether a requestAnimationFrame is already scheduled. */
let rafScheduled = false;

/** Pending overall progress data to flush. @type {any} */
let pendingProgressData = null;

/**
 * Status counters — maintained via transitions, never DOM-scanned.
 * @type {{ pending: number, analyzing: number, ready: number, uploading: number, completed: number, skipped: number, failed: number }}
 */
const counts = {
  pending: 0,
  analyzing: 0,
  ready: 0,
  uploading: 0,
  completed: 0,
  skipped: 0,
  failed: 0,
};

/**
 * Reset internal state (call when starting a new job or resetting).
 */
export function resetAnalysisState() {
  fileRowStatusCache.clear();
  pendingFileUpdates.clear();
  pendingProgressData = null;
  rafScheduled = false;

  counts.pending = 0;
  counts.analyzing = 0;
  counts.ready = 0;
  counts.uploading = 0;
  counts.completed = 0;
  counts.skipped = 0;
  counts.failed = 0;
}

/**
 * Initialize status counters for a new job.
 * @param {number} totalFiles
 */
export function initStatusCounts(totalFiles) {
  resetAnalysisState();
  counts.pending = totalFiles;
  updateCounterDisplay();
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
        counts.pending = analysisTotal;
        setText('files-total', data.total_files);
      }

      // Only count terminal statuses for progress bar (not pending/analyzing)
      if (data.file.status !== 'pending' && data.file.status !== 'analyzing') {
        analysisCompleted++;
      }

      // Update progress bar for analysis phase
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

/**
 * Flush all pending updates in a single animation frame.
 * Updates status counters and active upload rows — no per-file DOM scan.
 */
function flushUpdates() {
  rafScheduled = false;

  // Process all pending file updates: track status transitions and active files
  for (const [filename, fileData] of pendingFileUpdates) {
    const oldStatus = fileRowStatusCache.get(filename) || 'pending';
    const newStatus = fileData.is_duplicate ? 'skipped' : fileData.status;

    if (oldStatus !== newStatus) {
      // Decrement old counter
      if (oldStatus in counts) counts[/** @type {keyof counts} */ (oldStatus)]--;
      // Increment new counter
      if (newStatus in counts) counts[/** @type {keyof counts} */ (newStatus)]++;

      fileRowStatusCache.set(filename, newStatus);
    }
  }

  // Update active upload rows (only currently uploading/analyzing files)
  updateActiveRows();

  pendingFileUpdates.clear();

  // Update status counter display
  updateCounterDisplay();

  // Flush pending overall progress
  if (pendingProgressData) {
    updateProgressUI(pendingProgressData);
    pendingProgressData = null;
  }
}

/**
 * Update the active upload rows — only render files that are currently
 * uploading or analyzing (max ~4-8 rows instead of 20K).
 */
function updateActiveRows() {
  const container = document.getElementById('upload-active-list');
  if (!container) return;

  // Collect currently active files from pending updates
  /** @type {any[]} */
  const activeFiles = [];
  for (const [, fileData] of pendingFileUpdates) {
    if (fileData.status === 'uploading' || fileData.status === 'analyzing') {
      activeFiles.push(fileData);
    }
  }

  // Also keep rows that are still active but weren't in this update batch
  const existingRows = container.querySelectorAll('[data-upload-file]');
  for (const row of existingRows) {
    const filename = /** @type {HTMLElement} */ (row).getAttribute('data-upload-file') || '';
    const currentStatus = fileRowStatusCache.get(filename);
    if (currentStatus === 'uploading' || currentStatus === 'analyzing') {
      // Keep it if not being replaced by a pending update
      if (!pendingFileUpdates.has(filename)) continue;
    } else {
      // Status changed to non-active — remove row
      row.remove();
    }
  }

  // Upsert active file rows
  for (const fileData of activeFiles) {
    const row = container.querySelector(`[data-upload-file="${CSS.escape(fileData.filename)}"]`);

    if (row) {
      // Existing row — micro-update for progress
      if (fileData.status === 'uploading') {
        const bar = /** @type {HTMLElement | null} */ (row.querySelector('[data-progress-bar]'));
        if (bar) bar.style.width = `${fileData.progress_percent || 0}%`;
        const label = row.querySelector('[data-progress-label]');
        if (label) {
          label.textContent =
            fileData.progress_percent != null ? `${fileData.progress_percent.toFixed(0)}%` : '';
        }
      } else {
        // Status changed (e.g., pending → analyzing) — rebuild
        row.innerHTML = buildActiveRowHTML(fileData);
      }
    } else {
      // New active row
      const div = document.createElement('div');
      div.className = 'px-6 py-3 flex items-center justify-between';
      div.setAttribute('data-upload-file', fileData.filename);
      div.innerHTML = buildActiveRowHTML(fileData);
      container.appendChild(div);
    }
  }

  // Remove rows for files that completed/failed/skipped (no longer active)
  for (const row of container.querySelectorAll('[data-upload-file]')) {
    const filename = /** @type {HTMLElement} */ (row).getAttribute('data-upload-file') || '';
    const status = fileRowStatusCache.get(filename);
    if (status !== 'uploading' && status !== 'analyzing') {
      row.remove();
    }
  }
}

/**
 * Build HTML for an active file row.
 * @param {any} fileData
 * @returns {string}
 */
function buildActiveRowHTML(fileData) {
  let statusIcon = '';
  let statusText = '';

  if (fileData.status === 'uploading') {
    statusIcon =
      '<svg class="spinner h-5 w-5 text-nlr-blue" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';
    const pct = fileData.progress_percent != null ? `${fileData.progress_percent.toFixed(0)}%` : '';
    statusText = `
      <div class="flex items-center space-x-2">
        <div class="w-20 bg-gray-200 rounded-full h-2">
          <div data-progress-bar class="bg-nlr-blue h-2 rounded-full transition-[width] duration-300 ease-out" style="width: ${fileData.progress_percent || 0}%"></div>
        </div>
        <span data-progress-label class="text-xs text-gray-500 w-8">${pct}</span>
      </div>`;
  } else if (fileData.status === 'analyzing') {
    statusIcon =
      '<svg class="spinner h-5 w-5 text-blue-500" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';
    statusText = '<span class="text-xs text-blue-600">Validating</span>';
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
 * Update the status counter display from the counts object.
 * O(1) — just setting text on 5 elements.
 */
function updateCounterDisplay() {
  const active = counts.analyzing + counts.uploading;
  const queued = counts.pending + counts.ready;
  setText('upload-count-active', String(active));
  setText('upload-count-completed', String(counts.completed));
  setText('upload-count-skipped', String(counts.skipped));
  setText('upload-count-failed', String(counts.failed));
  setText('upload-count-queued', String(queued));
}

/**
 * @param {any} fileData
 * @returns {string}
 */
export function formatFileSize(fileData) {
  return fileData.file_size_formatted || formatBytes(fileData.file_size || 0);
}
