/**
 * Cancel and reset operations for uploads.
 */
import state from './state.js';
import { hideUploadSteps } from './stepper.js';
import { showNotification } from './utils.js';

export function cancelAnalysis() {
  resetUpload();
}

export async function cancelUpload() {
  if (!state.currentJobId) return;

  try {
    await fetch(`/api/upload/cancel/${state.currentJobId}`, { method: 'POST' });
    if (state.eventSource) state.eventSource.close();
    showNotification('Upload cancelled', 'info');
  } catch (_error) {
    showNotification('Failed to cancel upload', 'error');
  }
}

export function resetUpload() {
  state.currentJobId = null;
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  hideUploadSteps();

  document.getElementById('drop-zone')?.classList.remove('hidden');
  document.getElementById('analysis-section')?.classList.add('hidden');
  document.getElementById('progress-section')?.classList.add('hidden');
  document.getElementById('completion-section')?.classList.add('hidden');
  document.getElementById('scan-results-section')?.classList.add('hidden');

  const fileInput = /** @type {HTMLInputElement | null} */ (document.getElementById('file-input'));
  if (fileInput) fileInput.value = '';

  state.selectedFolderPath = null;
  state.scanFilePaths = [];
}
