import { checkForActiveJob } from './analysis.js';
import { apiPost } from './api.js';
import { hideEl, showEl } from './dom.js';
import { initFolderBrowser, showConfirmModal, startCombinedUpload } from './folder-browser.js';
/**
 * Upload page initialization and event wiring.
 */
import state from './state.js';
import { setUploadStep } from './stepper.js';
import { cancelUpload, resetUpload } from './upload-control.js';
import { downloadSummaryCSV } from './upload-exec.js';

export function initUpload() {
  const panel = document.getElementById('folder-browser-panel');
  if (!panel) return;

  initFolderBrowser();

  setUploadStep(1);
  checkForActiveJob();

  document.getElementById('cancel-upload-btn')?.addEventListener('click', cancelUpload);
  document.getElementById('upload-more-btn')?.addEventListener('click', resetUpload);
  document.getElementById('download-csv-btn')?.addEventListener('click', downloadSummaryCSV);

  document.getElementById('continue-upload-btn')?.addEventListener('click', showConfirmModal);
  document.getElementById('confirm-upload-btn')?.addEventListener('click', startCombinedUpload);

  document.getElementById('cancel-scan-btn')?.addEventListener('click', async () => {
    // Cancel active scan job if running
    if (state.scanJobId) {
      try {
        await apiPost(`/api/upload/cancel/${state.scanJobId}`);
      } catch (_error) {
        // Scan may have already finished
      }
      if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
      }
      state.scanJobId = null;
    }

    hideEl('scan-results-section');
    showEl('folder-browser-panel');
    state.selectedFolderPath = null;
    state.scanFilePaths = [];
    state.scanFileStatuses = [];
    state.scanTotalSize = 0;
    state.scanFolderPath = null;
    setUploadStep(1);
  });
}
