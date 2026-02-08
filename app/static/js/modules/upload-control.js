import { resetAnalysisState } from './analysis.js';
/**
 * Cancel and reset operations for uploads.
 */
import { apiPost } from './api.js';
import { hideEl, showEl } from './dom.js';
import { showNotification } from './notify.js';
import state from './state.js';
import { hideUploadSteps } from './stepper.js';

export async function cancelUpload() {
  if (!state.currentJobId) return;

  try {
    await apiPost(`/api/upload/cancel/${state.currentJobId}`);
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

  resetAnalysisState();
  hideUploadSteps();

  showEl('folder-browser-panel');
  hideEl('upload-section');
  hideEl('completion-section');
  hideEl('scan-results-section');
  hideEl('confirm-upload-modal');

  state.selectedFolderPath = null;
  state.scanFilePaths = [];
  state.scanFileStatuses = [];
  state.scanTotalSize = 0;
  state.scanFolderPath = null;
}
