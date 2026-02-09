/**
 * Upload step indicator management.
 */
import { setText } from './dom.js';
import { showNotification } from './notify.js';
import state from './state.js';

export const UPLOAD_STEPS = {
  1: { name: 'Select', description: 'Select files or a folder to upload' },
  2: {
    name: 'Review',
    description: 'Review files found - click Continue to upload, or Back to select different files',
  },
  3: { name: 'Upload', description: 'Validating and uploading files...' },
  4: { name: 'Complete', description: 'Upload complete!' },
};

/**
 * Set the current step in the upload flow.
 * @param {number} step
 */
export function setUploadStep(step) {
  state.currentStep = step;
  const stepsContainer = document.getElementById('upload-steps');
  if (!stepsContainer) return;

  for (let i = 1; i <= 4; i++) {
    const stepEl = stepsContainer.querySelector(`[data-step="${i}"]`);
    if (!stepEl) continue;

    stepEl.classList.remove('completed', 'active');

    if (i < step) {
      stepEl.classList.add('completed');
    } else if (i === step) {
      stepEl.classList.add('active');
    }
  }

  const connectors = stepsContainer.querySelectorAll('.step-connector');
  connectors.forEach((connector, index) => {
    /** @type {HTMLElement} */ (connector).style.backgroundColor =
      index < step - 1 ? '#5D9732' : '#D1D5DB';
  });

  if (UPLOAD_STEPS[step]) {
    setText('step-description', UPLOAD_STEPS[step].description);
  }
}

/**
 * Show the upload steps indicator and set the current step.
 * @param {number} step
 */
export function showUploadSteps(step) {
  setUploadStep(step);
}

/**
 * Reset the upload steps indicator to step 1.
 */
export function hideUploadSteps() {
  setUploadStep(1);
}

/**
 * Navigate to a specific step (for going back).
 * Uses dynamic import to avoid circular dependency with upload-control.
 * @param {number} targetStep
 */
export async function goToStep(targetStep) {
  if (targetStep >= state.currentStep) return;

  if (targetStep === 1 && state.currentStep <= 2) {
    const { resetUpload } = await import('./upload-control.js');
    resetUpload();
    return;
  }

  if (state.currentStep >= 3) {
    showNotification('Cannot go back during or after upload', 'error');
  }
}
