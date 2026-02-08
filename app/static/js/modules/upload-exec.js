/**
 * Upload execution: progress tracking and completion summary.
 */
import { hideEl, setText, showEl } from './dom.js';
import { formatDuration, formatEta } from './formatters.js';
import { fileIcon } from './icons.js';
import { showNotification } from './notify.js';
import { setUploadStep } from './stepper.js';

/** @type {any} */
let lastCompletedJob = null;

/**
 * @param {any} job
 */
export function updateProgressUI(job) {
  setText('progress-percent', job.progress_percent.toFixed(1));
  setText('files-completed', job.files_completed);
  setText('files-total', job.total_files);
  setText('bytes-uploaded', job.uploaded_bytes_formatted);
  setText('bytes-total', job.total_bytes_formatted);
  setText('eta', formatEta(job.eta_seconds));

  const progressBar = /** @type {HTMLElement | null} */ (document.getElementById('progress-bar'));
  if (progressBar) progressBar.style.width = `${job.progress_percent}%`;
}

/**
 * @param {any} job
 */
export function showCompletionSummary(job) {
  lastCompletedJob = job;
  setUploadStep(4);

  hideEl('upload-section');
  showEl('completion-section');

  const completed = job.files.filter((/** @type {any} */ f) => f.status === 'completed').length;
  const skipped = job.files.filter((/** @type {any} */ f) => f.status === 'skipped').length;
  const failed = job.files.filter((/** @type {any} */ f) => f.status === 'failed').length;

  setText('completed-count', completed);
  setText('skipped-count', skipped);
  setText('failed-count', failed);
  setText('total-uploaded-size', job.successfully_uploaded_bytes_formatted || '-');
  setText('total-upload-time', job.total_upload_duration_formatted || '-');
  setText(
    'avg-upload-speed',
    job.average_upload_speed_mbps ? `${job.average_upload_speed_mbps} Mbps` : '-',
  );

  const uploadedFiles = job.files.filter(
    (/** @type {any} */ f) => f.status === 'completed' && f.upload_duration_seconds,
  );
  if (uploadedFiles.length > 0) {
    const avgSeconds =
      uploadedFiles.reduce(
        (/** @type {number} */ sum, /** @type {any} */ f) => sum + f.upload_duration_seconds,
        0,
      ) / uploadedFiles.length;
    setText('avg-file-time', formatDuration(avgSeconds));
  } else {
    setText('avg-file-time', '-');
  }

  const tbody = document.getElementById('completion-file-list');
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
                            ${fileIcon('h-4 w-4 text-gray-400 mr-2')}
                            <span class="text-sm text-gray-900 truncate" title="${file.filename}">${file.filename}</span>
                        </div>
                    </td>
                    <td class="px-4 py-3 text-sm text-gray-500 truncate" title="${file.s3_path || ''}">${file.s3_path || '-'}</td>
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

/**
 * Download the upload summary as a CSV file.
 */
export function downloadSummaryCSV() {
  if (!lastCompletedJob || !lastCompletedJob.files) {
    showNotification('No upload data available', 'error');
    return;
  }

  const headers = ['Filename', 'Size', 'S3 Path', 'Status', 'Duration', 'Speed'];
  const rows = lastCompletedJob.files.map((/** @type {any} */ file) => {
    const duration = file.upload_duration_seconds
      ? formatDuration(file.upload_duration_seconds)
      : '';
    const speed = file.upload_speed_mbps ? `${file.upload_speed_mbps} Mbps` : '';
    return [
      file.filename,
      file.file_size_formatted || '',
      file.s3_path || '',
      file.status,
      duration,
      speed,
    ];
  });

  const csvContent = [
    headers.join(','),
    ...rows.map((/** @type {string[]} */ row) =>
      row.map((/** @type {string} */ cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','),
    ),
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const now = new Date();
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  link.download = `upload-summary-${now.toISOString().slice(0, 10)}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
