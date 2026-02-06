/**
 * Upload execution: start upload, SSE progress tracking, completion summary.
 */
import state from './state.js';
import { setUploadStep } from './stepper.js';
import { formatDuration, formatEta, showNotification } from './utils.js';

export async function startUpload() {
  if (!state.currentJobId) return;

  const skipDuplicatesEl = /** @type {HTMLInputElement | null} */ (
    document.getElementById('skip-duplicates')
  );
  const skipDuplicates = skipDuplicatesEl?.checked ?? true;

  setUploadStep(4);

  document.getElementById('analysis-section')?.classList.add('hidden');
  document.getElementById('progress-section')?.classList.remove('hidden');

  try {
    const response = await fetch(`/api/upload/start/${state.currentJobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skip_duplicates: skipDuplicates }),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Failed to start upload');
    }

    connectProgressStream();
  } catch (error) {
    showNotification(/** @type {Error} */ (error).message, 'error');
  }
}

export function connectProgressStream() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  state.eventSource = new EventSource(`/api/upload/progress/${state.currentJobId}`);

  state.eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.error) {
      showNotification(data.error, 'error');
      state.eventSource?.close();
      return;
    }

    updateProgressUI(data);

    if (['completed', 'failed', 'cancelled'].includes(data.status)) {
      state.eventSource?.close();
      showCompletionSummary(data);
    }
  };

  state.eventSource.onerror = () => {
    state.eventSource?.close();
    showNotification('Connection to server lost', 'error');
  };
}

/**
 * @param {any} job
 */
export function updateProgressUI(job) {
  const el = (/** @type {string} */ id) => document.getElementById(id);

  const progressPercent = el('progress-percent');
  if (progressPercent) progressPercent.textContent = job.progress_percent.toFixed(1);

  const progressBar = /** @type {HTMLElement | null} */ (el('progress-bar'));
  if (progressBar) progressBar.style.width = `${job.progress_percent}%`;

  const filesCompleted = el('files-completed');
  if (filesCompleted) filesCompleted.textContent = job.files_completed;

  const filesTotal = el('files-total');
  if (filesTotal) filesTotal.textContent = job.total_files;

  const bytesUploaded = el('bytes-uploaded');
  if (bytesUploaded) bytesUploaded.textContent = job.uploaded_bytes_formatted;

  const bytesTotal = el('bytes-total');
  if (bytesTotal) bytesTotal.textContent = job.total_bytes_formatted;

  const eta = el('eta');
  if (eta) eta.textContent = formatEta(job.eta_seconds);

  const progressList = el('progress-list');
  if (progressList) {
    progressList.innerHTML = job.files
      .map((/** @type {any} */ file) => {
        const statusIcon =
          file.status === 'completed'
            ? '<svg class="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>'
            : file.status === 'failed'
              ? '<svg class="h-5 w-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>'
              : file.status === 'skipped'
                ? '<svg class="h-5 w-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 9l3 3m0 0l-3 3m3-3H8m13 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>'
                : file.status === 'uploading'
                  ? '<svg class="spinner h-5 w-5 text-nrel-blue" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>'
                  : '<div class="h-5 w-5"></div>';

        return `
                <div class="px-6 py-3 flex items-center justify-between">
                    <div class="flex items-center space-x-3">
                        ${statusIcon}
                        <span class="text-sm text-gray-900">${file.filename}</span>
                    </div>
                    <div class="flex items-center space-x-4">
                        <span class="text-sm text-gray-500">${file.file_size_formatted}</span>
                        ${
                          file.status === 'uploading'
                            ? `
                            <div class="w-24 bg-gray-200 rounded-full h-2">
                                <div class="bg-nrel-blue h-2 rounded-full" style="width: ${file.progress_percent}%"></div>
                            </div>
                            <span class="text-sm text-gray-500 w-12">${file.progress_percent.toFixed(0)}%</span>
                        `
                            : ''
                        }
                    </div>
                </div>
            `;
      })
      .join('');
  }
}

/**
 * @param {any} job
 */
export function showCompletionSummary(job) {
  setUploadStep(5);

  document.getElementById('progress-section')?.classList.add('hidden');
  document.getElementById('completion-section')?.classList.remove('hidden');

  const completed = job.files.filter((/** @type {any} */ f) => f.status === 'completed').length;
  const skipped = job.files.filter((/** @type {any} */ f) => f.status === 'skipped').length;
  const failed = job.files.filter((/** @type {any} */ f) => f.status === 'failed').length;

  const el = (/** @type {string} */ id) => document.getElementById(id);

  const completedCount = el('completed-count');
  if (completedCount) completedCount.textContent = String(completed);

  const skippedCount = el('skipped-count');
  if (skippedCount) skippedCount.textContent = String(skipped);

  const failedCount = el('failed-count');
  if (failedCount) failedCount.textContent = String(failed);

  const totalUploadedSize = el('total-uploaded-size');
  if (totalUploadedSize) {
    totalUploadedSize.textContent = job.successfully_uploaded_bytes_formatted || '-';
  }

  const totalUploadTime = el('total-upload-time');
  if (totalUploadTime) {
    totalUploadTime.textContent = job.total_upload_duration_formatted || '-';
  }

  const avgUploadSpeed = el('avg-upload-speed');
  if (avgUploadSpeed) {
    avgUploadSpeed.textContent = job.average_upload_speed_mbps
      ? `${job.average_upload_speed_mbps} Mbps`
      : '-';
  }

  const uploadedFiles = job.files.filter(
    (/** @type {any} */ f) => f.status === 'completed' && f.upload_duration_seconds,
  );
  const avgFileTime = el('avg-file-time');
  if (avgFileTime) {
    if (uploadedFiles.length > 0) {
      const avgSeconds =
        uploadedFiles.reduce(
          (/** @type {number} */ sum, /** @type {any} */ f) => sum + f.upload_duration_seconds,
          0,
        ) / uploadedFiles.length;
      avgFileTime.textContent = formatDuration(avgSeconds);
    } else {
      avgFileTime.textContent = '-';
    }
  }

  const tbody = el('completion-file-list');
  if (tbody) {
    tbody.innerHTML = job.files
      .map((/** @type {any} */ file) => {
        let statusBadge;
        let statusClass;
        if (file.status === 'completed') {
          statusBadge = 'Uploaded';
          statusClass = 'bg-green-100 text-green-800';
        } else if (file.status === 'skipped') {
          statusBadge = 'Skipped';
          statusClass = 'bg-yellow-100 text-yellow-800';
        } else if (file.status === 'failed') {
          statusBadge = 'Failed';
          statusClass = 'bg-red-100 text-red-800';
        } else {
          statusBadge = file.status;
          statusClass = 'bg-gray-100 text-gray-800';
        }

        const duration = file.upload_duration_seconds
          ? formatDuration(file.upload_duration_seconds)
          : '-';
        const speed = file.upload_speed_mbps ? `${file.upload_speed_mbps} Mbps` : '-';

        return `
                <tr>
                    <td class="px-4 py-3">
                        <div class="flex items-center">
                            <svg class="h-4 w-4 text-gray-400 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <span class="text-sm text-gray-900 truncate" title="${file.filename}">${file.filename}</span>
                        </div>
                    </td>
                    <td class="px-4 py-3 text-sm text-gray-500">${file.file_size_formatted}</td>
                    <td class="px-4 py-3 text-sm text-gray-500">${duration}</td>
                    <td class="px-4 py-3 text-sm text-gray-500">${speed}</td>
                    <td class="px-4 py-3">
                        <span class="px-2 py-1 text-xs rounded-full ${statusClass}">${statusBadge}</span>
                    </td>
                </tr>
            `;
      })
      .join('');
  }

  if (failed === 0) {
    showNotification('Upload completed successfully!', 'success');
  } else {
    showNotification(`Upload completed with ${failed} failed files`, 'error');
  }
}
