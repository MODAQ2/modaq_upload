/**
 * Upload step indicator management.
 */
import state from './state.js';
import { showNotification } from './utils.js';

export const UPLOAD_STEPS = {
  1: { name: 'Select', description: 'Select files or a folder to upload' },
  2: {
    name: 'Review',
    description:
      'Review files found - click Validate to continue, or Back to select different files',
  },
  3: { name: 'Validate', description: 'Extracting timestamps and checking for duplicates...' },
  4: { name: 'Upload', description: 'Uploading files to S3...' },
  5: { name: 'Complete', description: 'Upload complete!' },
};

export const STEP_3_VALIDATING = 'Extracting timestamps and checking for duplicates...';
export const STEP_3_VALIDATED = 'Validation complete - review results and click Upload Files';

/**
 * Set the current step in the upload flow.
 * @param {number} step
 */
export function setUploadStep(step) {
  state.currentStep = step;
  const stepsContainer = document.getElementById('upload-steps');
  if (!stepsContainer) return;

  for (let i = 1; i <= 5; i++) {
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

  const descriptionEl = document.getElementById('step-description');
  if (descriptionEl && UPLOAD_STEPS[step]) {
    descriptionEl.textContent = UPLOAD_STEPS[step].description;
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

  if (targetStep === 1 && state.currentStep <= 3) {
    const { resetUpload } = await import('./upload-control.js');
    resetUpload();
    return;
  }

  if (targetStep === 2 && state.currentStep === 3) {
    const { resetUpload } = await import('./upload-control.js');
    showNotification('Going back to file selection', 'info');
    resetUpload();
    return;
  }

  if (state.currentStep >= 4) {
    showNotification('Cannot go back during or after upload', 'error');
  }
}
