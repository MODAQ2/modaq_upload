/**
 * modaq-upload - Entry Point
 *
 * Detects the current page via data-page attribute and dynamically
 * imports the appropriate module. Registers delegated click handlers
 * for data-action attributes (replacing inline onclick).
 */
import {
  closeAboutModal,
  initAboutModal,
  loadHeaderVersion,
  openAboutModal,
} from './modules/about.js';
import { goToStep } from './modules/stepper.js';

// Global initialization (runs on every page)
initAboutModal();
loadHeaderVersion();

// Delegated click handler for data-action attributes
document.addEventListener('click', (e) => {
  const target = /** @type {HTMLElement} */ (e.target).closest('[data-action]');
  if (!target) return;

  const action = /** @type {HTMLElement} */ (target).dataset.action;

  if (action === 'open-about') {
    openAboutModal();
  } else if (action === 'close-about') {
    closeAboutModal();
  } else if (action === 'go-to-step') {
    const step = Number(/** @type {HTMLElement} */ (target).dataset.step);
    if (step) goToStep(step);
  }
});

// Page-specific module loading
const page = document.body.dataset.page;

if (page === 'upload') {
  import('./modules/upload-init.js').then(({ initUpload }) => initUpload());
} else if (page === 'files') {
  import('./modules/file-browser.js').then(({ initFileBrowser }) => initFileBrowser());
} else if (page === 'settings') {
  import('./modules/settings.js').then(({ initSettings }) => initSettings());
}
