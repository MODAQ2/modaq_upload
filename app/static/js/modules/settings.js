import { apiGet, apiPost, apiPut } from './api.js';
import { appendText, setText, showEl, withLoadingButton } from './dom.js';
import { showNotification } from './notify.js';
/**
 * Settings page functionality.
 */
import state from './state.js';

const AWS_REGION_OPTIONS = new Set([
  'us-west-2',
  'us-west-1',
  'us-east-1',
  'us-east-2',
  'us-gov-west-1',
  'us-gov-east-1',
]);

function getAwsRegion() {
  const select = /** @type {HTMLSelectElement | null} */ (
    document.getElementById('aws-region-select')
  );
  if (select?.value === 'other') {
    const custom = /** @type {HTMLInputElement | null} */ (
      document.getElementById('aws-region-custom')
    );
    return custom?.value.trim() || '';
  }
  return select?.value || 'us-west-2';
}

/**
 * @param {string} region
 */
function setAwsRegion(region) {
  const select = /** @type {HTMLSelectElement | null} */ (
    document.getElementById('aws-region-select')
  );
  const customInput = document.getElementById('aws-region-custom');
  const helpText = document.getElementById('aws-region-help');

  if (!select || !customInput || !helpText) return;

  if (AWS_REGION_OPTIONS.has(region)) {
    select.value = region;
    customInput.classList.add('hidden');
    helpText.classList.add('hidden');
    /** @type {HTMLInputElement} */ (customInput).value = '';
  } else {
    select.value = 'other';
    /** @type {HTMLInputElement} */ (customInput).value = region;
    customInput.classList.remove('hidden');
    helpText.classList.remove('hidden');
  }
}

export function initSettings() {
  const form = document.getElementById('settings-form');
  if (!form) return;

  document.getElementById('aws-region-select')?.addEventListener('change', (e) => {
    const customInput = document.getElementById('aws-region-custom');
    const helpText = document.getElementById('aws-region-help');
    if (/** @type {HTMLSelectElement} */ (e.target).value === 'other') {
      customInput?.classList.remove('hidden');
      helpText?.classList.remove('hidden');
      /** @type {HTMLInputElement} */ (customInput)?.focus();
    } else {
      customInput?.classList.add('hidden');
      helpText?.classList.add('hidden');
      if (customInput) /** @type {HTMLInputElement} */ (customInput).value = '';
    }
  });

  loadCurrentSettings();
  loadAwsProfiles();
  loadVersionInfo();
  loadCacheStats();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveSettings();
  });

  document.getElementById('test-connection-btn')?.addEventListener('click', testConnection);
  document.getElementById('check-updates-btn')?.addEventListener('click', checkForUpdates);
  document.getElementById('run-update-btn')?.addEventListener('click', runUpdate);
  document.getElementById('reset-settings-btn')?.addEventListener('click', resetSettings);
  document.getElementById('clear-cache-btn')?.addEventListener('click', clearBrowserCache);
  document.getElementById('sync-cache-btn')?.addEventListener('click', syncCacheWithAws);
  document.getElementById('invalidate-cache-btn')?.addEventListener('click', invalidateUploadCache);
}

async function loadCurrentSettings() {
  try {
    const settings = await apiGet('/api/settings');

    setAwsRegion(settings.aws_region || 'us-west-2');

    const s3Bucket = /** @type {HTMLInputElement | null} */ (document.getElementById('s3-bucket'));
    if (s3Bucket) s3Bucket.value = settings.s3_bucket || '';

    const defaultFolder = /** @type {HTMLInputElement | null} */ (
      document.getElementById('default-folder')
    );
    if (defaultFolder) defaultFolder.value = settings.default_upload_folder || '';

    state.currentAwsProfile = settings.aws_profile;
  } catch (_error) {
    showNotification('Failed to load settings', 'error');
  }
}

async function loadAwsProfiles() {
  try {
    const data = await apiGet('/api/settings/profiles');

    const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('aws-profile'));
    if (!select) return;

    select.innerHTML = data.profiles
      .map((/** @type {string} */ profile) => `<option value="${profile}">${profile}</option>`)
      .join('');

    if (state.currentAwsProfile) {
      select.value = state.currentAwsProfile;
    }
  } catch (_error) {
    showNotification('Failed to load AWS profiles', 'error');
  }
}

async function loadVersionInfo() {
  try {
    const data = await apiGet('/api/settings/version');

    setText('git-branch', data.branch || '-');
    setText('git-commit', data.commit || '-');
    setText('git-date', data.last_updated || '-');
    setText('pkg-version', data.version || '-');

    let versionText = data.version || '0.0.0';
    if (data.commit) {
      versionText += ` (${data.commit})`;
    }
    setText('version-info', versionText);
  } catch (error) {
    console.error('Failed to load version info:', error);
  }
}

async function saveSettings() {
  const settings = {
    aws_profile: /** @type {HTMLSelectElement} */ (document.getElementById('aws-profile'))?.value,
    aws_region: getAwsRegion(),
    s3_bucket: /** @type {HTMLInputElement} */ (document.getElementById('s3-bucket'))?.value,
    default_upload_folder: /** @type {HTMLInputElement} */ (
      document.getElementById('default-folder')
    )?.value,
  };

  try {
    await apiPut('/api/settings', settings);
    showNotification('Settings saved successfully', 'success');
  } catch (error) {
    showNotification(/** @type {Error} */ (error).message, 'error');
  }
}

async function testConnection() {
  const btn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('test-connection-btn')
  );
  const status = document.getElementById('connection-status');
  if (!btn || !status) return;

  status.textContent = 'Testing connection...';
  status.className = 'mt-1 text-sm text-gray-500';

  const settings = {
    aws_profile: /** @type {HTMLSelectElement} */ (document.getElementById('aws-profile'))?.value,
    aws_region: getAwsRegion(),
    s3_bucket: /** @type {HTMLInputElement} */ (document.getElementById('s3-bucket'))?.value,
  };

  await withLoadingButton(btn, 'Testing...', async () => {
    try {
      const data = await apiPost('/api/settings/validate', settings);
      status.textContent = data.success ? data.message : data.error;
      status.className = `mt-1 text-sm ${data.success ? 'text-green-600' : 'text-red-600'}`;
    } catch (error) {
      status.textContent = /** @type {Error} */ (error).message;
      status.className = 'mt-1 text-sm text-red-600';
    }
  });
}

async function checkForUpdates() {
  const btn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('check-updates-btn')
  );
  const status = document.getElementById('update-status');
  const updateBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('run-update-btn')
  );
  if (!btn || !status) return;

  await withLoadingButton(btn, 'Checking...', async () => {
    try {
      const data = await apiGet('/api/settings/check-updates');

      if (data.error) {
        status.textContent = `Error: ${data.error}`;
        status.className = 'text-sm text-red-600';
      } else if (data.updates_available) {
        status.textContent = 'Updates available! Click "Update Application" to install.';
        status.className = 'text-sm text-nlr-yellow font-medium';
        if (updateBtn) updateBtn.disabled = false;
      } else if (data.up_to_date) {
        status.textContent = 'Application is up to date.';
        status.className = 'text-sm text-green-600';
      } else {
        status.textContent = 'Could not determine update status.';
        status.className = 'text-sm text-gray-600';
      }
    } catch (error) {
      status.textContent = /** @type {Error} */ (error).message;
      status.className = 'text-sm text-red-600';
    }
  });
}

async function runUpdate() {
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('run-update-btn'));
  const status = document.getElementById('update-status');
  if (!btn || !status) return;

  status.textContent = 'Running update...';
  showEl('update-log');
  setText('update-output', 'Starting update...\n');

  await withLoadingButton(btn, 'Updating...', async () => {
    try {
      const data = await apiPost('/api/settings/update');

      let output = '';

      if (data.results.git_pull) {
        output += '=== Git Pull ===\n';
        output += data.results.git_pull.success ? '[SUCCESS]\n' : '[FAILED]\n';
        output += `${data.results.git_pull.output}\n\n`;
      }

      if (data.results.pip_install) {
        output += '=== Pip Install ===\n';
        output += data.results.pip_install.success ? '[SUCCESS]\n' : '[FAILED]\n';
        output += `${data.results.pip_install.output}\n\n`;
      }

      if (data.results.modaq_toolkit) {
        output += '=== MODAQ Toolkit Update ===\n';
        output += data.results.modaq_toolkit.success ? '[SUCCESS]\n' : '[FAILED]\n';
        output += `${data.results.modaq_toolkit.output}\n`;
      }

      setText('update-output', output);

      if (data.success) {
        status.textContent = 'Update completed! Restart the application to apply changes.';
        status.className = 'text-sm text-green-600 font-medium';
        showNotification('Update completed! Please restart the application.', 'success');
      } else {
        status.textContent = 'Update completed with some errors. Check the log below.';
        status.className = 'text-sm text-yellow-600';
      }

      loadVersionInfo();
    } catch (error) {
      status.textContent = /** @type {Error} */ (error).message;
      status.className = 'text-sm text-red-600';
      appendText('update-output', `\nError: ${/** @type {Error} */ (error).message}`);
    }
  });
}

async function resetSettings() {
  if (!confirm('Are you sure you want to reset all settings to defaults?')) {
    return;
  }

  try {
    await apiPut('/api/settings', {
      aws_profile: 'default',
      aws_region: 'us-west-2',
      s3_bucket: '',
      default_upload_folder: '',
    });

    loadCurrentSettings();
    showNotification('Settings reset to defaults', 'success');
  } catch (error) {
    showNotification(/** @type {Error} */ (error).message, 'error');
  }
}

function clearBrowserCache() {
  if (
    !confirm(
      'Are you sure you want to clear the browser cache? This will forget your last used folder and other local preferences.',
    )
  ) {
    return;
  }

  try {
    localStorage.removeItem('lastUploadFolder');
    showNotification('Browser cache cleared', 'success');
  } catch (error) {
    showNotification(`Failed to clear cache: ${/** @type {Error} */ (error).message}`, 'error');
  }
}

async function loadCacheStats() {
  try {
    const data = await apiGet('/api/settings/cache/stats');

    if (data.success && data.stats) {
      const stats = data.stats;

      setText('cache-total', stats.total_entries || 0);
      setText('cache-exists', stats.exists_count || 0);
      setText('cache-deleted', stats.not_exists_count || 0);

      if (stats.last_full_sync) {
        setText('cache-last-sync', new Date(stats.last_full_sync).toLocaleString());
      } else {
        setText('cache-last-sync', 'Never');
      }
    }
  } catch (error) {
    console.error('Failed to load cache stats:', error);
  }
}

async function syncCacheWithAws() {
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('sync-cache-btn'));
  const status = document.getElementById('sync-status');
  if (!btn || !status) return;

  status.classList.remove('hidden');
  status.textContent = 'Fetching file list from S3...';
  status.className = 'mt-2 text-sm text-gray-600';

  await withLoadingButton(btn, 'Syncing...', async () => {
    try {
      const data = await apiPost('/api/settings/cache/sync');

      if (data.success) {
        status.textContent = data.message;
        status.className = 'mt-2 text-sm text-green-600';
        showNotification(data.message, 'success');
        loadCacheStats();
      } else {
        status.textContent = `Error: ${data.error}`;
        status.className = 'mt-2 text-sm text-red-600';
        showNotification(data.error, 'error');
      }
    } catch (error) {
      status.textContent = `Error: ${/** @type {Error} */ (error).message}`;
      status.className = 'mt-2 text-sm text-red-600';
      showNotification(/** @type {Error} */ (error).message, 'error');
    }
  });
}

async function invalidateUploadCache() {
  if (
    !confirm(
      'Are you sure you want to clear the upload cache? This will delete all cached file records for the current bucket. The next upload will need to re-check all files against S3.',
    )
  ) {
    return;
  }

  const btn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('invalidate-cache-btn')
  );

  await withLoadingButton(btn, 'Clearing...', async () => {
    try {
      const data = await apiPost('/api/settings/cache/invalidate');

      if (data.success) {
        showNotification(data.message, 'success');
        loadCacheStats();
      } else {
        showNotification(data.error || 'Failed to clear cache', 'error');
      }
    } catch (error) {
      showNotification(/** @type {Error} */ (error).message, 'error');
    }
  });
}
