/**
 * About modal functionality.
 */
import { apiGet } from './api.js';
import { hideEl, setText, showEl } from './dom.js';
import state from './state.js';

/**
 * Load version info from the API and populate header badge.
 */
export async function loadHeaderVersion() {
  try {
    const data = await apiGet('/api/settings/version');
    state.appVersionData = data;
    setText('header-version', data.version || '0.0.0');
  } catch {
    setText('header-version', '?');
  }
}

export function openAboutModal() {
  showEl('about-modal');
  document.body.style.overflow = 'hidden';

  if (state.appVersionData) {
    setText('about-version', state.appVersionData.version || '0.0.0');
    setText('about-commit', state.appVersionData.commit || '-');
    setText('about-branch', state.appVersionData.branch || '-');
  }
}

export function closeAboutModal() {
  hideEl('about-modal');
  document.body.style.overflow = '';
}

/**
 * Initialize about modal event listeners.
 */
export function initAboutModal() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAboutModal();
    }
  });

  const modal = document.getElementById('about-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeAboutModal();
      }
    });
  }
}
