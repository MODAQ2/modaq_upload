/**
 * Upload execution: progress tracking and completion summary.
 * Completion table is paginated (100 rows per page) for 20K+ file performance.
 */
import { hideEl, setText, showEl } from './dom.js';
import { formatDuration, formatEta } from './formatters.js';
import { fileIcon } from './icons.js';
import { showNotification } from './notify.js';
import { setUploadStep } from './stepper.js';

const COMPLETION_PAGE_SIZE = 100;

/** @type {any} */
let lastCompletedJob = null;

/** Current page (0-indexed) of the completion table. */
let completionPage = 0;

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
  completionPage = 0;
  setUploadStep(4);

  hideEl('upload-section');
  showEl('completion-section');

  // Use pre-computed counts from backend (avoids 3 filter passes over 20K files)
  const completed =
    job.files_uploaded ??
    job.files.filter((/** @type {any} */ f) => f.status === 'completed').length;
  const skipped =
    job.files_skipped ?? job.files.filter((/** @type {any} */ f) => f.status === 'skipped').length;
  const failed =
    job.files_failed ?? job.files.filter((/** @type {any} */ f) => f.status === 'failed').length;

  setText('completed-count', completed);
  setText('skipped-count', skipped);
  setText('failed-count', failed);
  setText('total-uploaded-size', job.successfully_uploaded_bytes_formatted || '-');
  setText('total-upload-time', job.total_upload_duration_formatted || '-');
  setText(
    'avg-upload-speed',
    job.average_upload_speed_mbps ? `${job.average_upload_speed_mbps} Mbps` : '-',
  );

  // Single pass for average per-file duration (not pre-computed by backend)
  let durationSum = 0;
  let durationCount = 0;
  for (const f of job.files) {
    if (f.status === 'completed' && f.upload_duration_seconds) {
      durationSum += f.upload_duration_seconds;
      durationCount++;
    }
  }
  setText('avg-file-time', durationCount > 0 ? formatDuration(durationSum / durationCount) : '-');

  // Render first page and wire up pagination
  renderCompletionPage();
  wireCompletionPagination();

  if (failed === 0) {
    showNotification('Upload completed successfully!', 'success');
  } else {
    showNotification(`Upload completed with ${failed} failed files`, 'error');
  }
}

/**
 * Render the current page of the completion file table.
 */
function renderCompletionPage() {
  if (!lastCompletedJob) return;

  const files = lastCompletedJob.files;
  const totalPages = Math.max(1, Math.ceil(files.length / COMPLETION_PAGE_SIZE));
  const start = completionPage * COMPLETION_PAGE_SIZE;
  const end = Math.min(start + COMPLETION_PAGE_SIZE, files.length);
  const pageFiles = files.slice(start, end);

  const tbody = document.getElementById('completion-file-list');
  if (tbody) {
    tbody.innerHTML = pageFiles
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

  // Update pagination controls
  setText('completion-page-info', `Page ${completionPage + 1} of ${totalPages}`);

  const prevBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('completion-prev-btn')
  );
  const nextBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('completion-next-btn')
  );
  if (prevBtn) prevBtn.disabled = completionPage === 0;
  if (nextBtn) nextBtn.disabled = completionPage >= totalPages - 1;
}

/**
 * Wire up pagination button click handlers.
 */
function wireCompletionPagination() {
  const prevBtn = document.getElementById('completion-prev-btn');
  const nextBtn = document.getElementById('completion-next-btn');

  if (prevBtn) {
    prevBtn.onclick = () => {
      if (completionPage > 0) {
        completionPage--;
        renderCompletionPage();
      }
    };
  }

  if (nextBtn) {
    nextBtn.onclick = () => {
      if (!lastCompletedJob) return;
      const totalPages = Math.ceil(lastCompletedJob.files.length / COMPLETION_PAGE_SIZE);
      if (completionPage < totalPages - 1) {
        completionPage++;
        renderCompletionPage();
      }
    };
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
