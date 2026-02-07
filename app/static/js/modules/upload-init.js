import { applyUploadedFilter, checkForActiveJob } from './analysis.js';
import { initFolderBrowser, startDirectUpload } from './folder-browser.js';
/**
 * Upload page initialization and event wiring.
 */
import state from './state.js';
import { setUploadStep } from './stepper.js';
import { cancelAnalysis, cancelUpload, resetUpload } from './upload-control.js';
import { startUpload } from './upload-exec.js';

export function initUpload() {
  const panel = document.getElementById('folder-browser-panel');
  if (!panel) return;

  initFolderBrowser();

  setUploadStep(1);
  checkForActiveJob();

  document.getElementById('upload-btn')?.addEventListener('click', startUpload);
  document.getElementById('cancel-analyze-btn')?.addEventListener('click', cancelAnalysis);
  document.getElementById('cancel-upload-btn')?.addEventListener('click', cancelUpload);
  document.getElementById('upload-more-btn')?.addEventListener('click', resetUpload);

  document.getElementById('hide-uploaded')?.addEventListener('change', applyUploadedFilter);

  document.getElementById('start-upload-btn')?.addEventListener('click', startDirectUpload);
  document.getElementById('cancel-scan-btn')?.addEventListener('click', () => {
    document.getElementById('scan-results-section')?.classList.add('hidden');
    document.getElementById('folder-browser-panel')?.classList.remove('hidden');
    state.selectedFolderPath = null;
    setUploadStep(1);
  });
}
