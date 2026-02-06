import { applyUploadedFilter, checkForActiveJob, handleFiles } from './analysis.js';
import { extractFilesFromDrop } from './file-handler.js';
import { initFolderBrowser, openFolderBrowser, startDirectUpload } from './folder-browser.js';
/**
 * Upload page initialization and event wiring.
 */
import state from './state.js';
import { setUploadStep } from './stepper.js';
import { cancelAnalysis, cancelUpload, resetUpload } from './upload-control.js';
import { startUpload } from './upload-exec.js';
import { showNotification } from './utils.js';

export function initUpload() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = /** @type {HTMLInputElement | null} */ (document.getElementById('file-input'));
  const folderBtn = document.getElementById('folder-btn');

  if (!dropZone) return;

  initFolderBrowser();

  setUploadStep(1);
  checkForActiveJob();

  folderBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    openFolderBrowser();
  });

  dropZone.addEventListener('click', (e) => {
    if (
      /** @type {HTMLElement} */ (e.target).id === 'folder-btn' ||
      /** @type {HTMLElement} */ (e.target).closest('#folder-btn')
    ) {
      return;
    }
    fileInput?.click();
  });

  fileInput?.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      handleFiles(Array.from(fileInput.files));
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');

    const items = e.dataTransfer?.items;
    if (items && items.length > 0) {
      const files = await extractFilesFromDrop(items);
      const mcapFiles = files.filter((f) => f.name.endsWith('.mcap'));
      if (mcapFiles.length > 0) {
        handleFiles(mcapFiles);
      } else {
        showNotification('No MCAP files found in dropped items', 'error');
      }
    } else {
      const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.name.endsWith('.mcap'));
      if (files.length > 0) {
        handleFiles(files);
      } else {
        showNotification('Please drop MCAP files only', 'error');
      }
    }
  });

  document.getElementById('upload-btn')?.addEventListener('click', startUpload);
  document.getElementById('cancel-analyze-btn')?.addEventListener('click', cancelAnalysis);
  document.getElementById('cancel-upload-btn')?.addEventListener('click', cancelUpload);
  document.getElementById('upload-more-btn')?.addEventListener('click', resetUpload);

  document.getElementById('hide-uploaded')?.addEventListener('change', applyUploadedFilter);

  document.getElementById('start-upload-btn')?.addEventListener('click', startDirectUpload);
  document.getElementById('cancel-scan-btn')?.addEventListener('click', () => {
    document.getElementById('scan-results-section')?.classList.add('hidden');
    document.getElementById('drop-zone')?.classList.remove('hidden');
    state.selectedFolderPath = null;
  });
}
