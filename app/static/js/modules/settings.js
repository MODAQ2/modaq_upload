import state from './state.js';
/**
 * Settings page functionality.
 */
import { showNotification } from './utils.js';

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
    const response = await fetch('/api/settings');
    const settings = await response.json();

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
    const response = await fetch('/api/settings/profiles');
    const data = await response.json();

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
    const response = await fetch('/api/settings/version');
    const data = await response.json();

    const gitBranch = document.getElementById('git-branch');
    if (gitBranch) gitBranch.textContent = data.branch || '-';

    const gitCommit = document.getElementById('git-commit');
    if (gitCommit) gitCommit.textContent = data.commit || '-';

    const gitDate = document.getElementById('git-date');
    if (gitDate) gitDate.textContent = data.last_updated || '-';

    const pkgVersion = document.getElementById('pkg-version');
    if (pkgVersion) pkgVersion.textContent = data.version || '-';

    const versionInfo = document.getElementById('version-info');
    if (versionInfo) {
      let versionText = data.version || '0.0.0';
      if (data.commit) {
        versionText += ` (${data.commit})`;
      }
      versionInfo.textContent = versionText;
    }
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
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Failed to save settings');
    }

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

  btn.disabled = true;
  btn.textContent = 'Testing...';
  status.textContent = 'Testing connection...';
  status.className = 'mt-1 text-sm text-gray-500';

  const settings = {
    aws_profile: /** @type {HTMLSelectElement} */ (document.getElementById('aws-profile'))?.value,
    aws_region: getAwsRegion(),
    s3_bucket: /** @type {HTMLInputElement} */ (document.getElementById('s3-bucket'))?.value,
  };

  try {
    const response = await fetch('/api/settings/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });

    const data = await response.json();

    if (data.success) {
      status.textContent = data.message;
      status.className = 'mt-1 text-sm text-green-600';
    } else {
      status.textContent = data.error;
      status.className = 'mt-1 text-sm text-red-600';
    }
  } catch (error) {
    status.textContent = /** @type {Error} */ (error).message;
    status.className = 'mt-1 text-sm text-red-600';
  }

  btn.disabled = false;
  btn.textContent = 'Test Connection';
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

  btn.disabled = true;
  btn.textContent = 'Checking...';

  try {
    const response = await fetch('/api/settings/check-updates');
    const data = await response.json();

    if (data.error) {
      status.textContent = `Error: ${data.error}`;
      status.className = 'text-sm text-red-600';
    } else if (data.updates_available) {
      status.textContent = 'Updates available! Click "Update Application" to install.';
      status.className = 'text-sm text-nrel-yellow font-medium';
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

  btn.disabled = false;
  btn.textContent = 'Check for Updates';
}

async function runUpdate() {
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('run-update-btn'));
  const status = document.getElementById('update-status');
  const logSection = document.getElementById('update-log');
  const logOutput = document.getElementById('update-output');
  if (!btn || !status || !logSection || !logOutput) return;

  btn.disabled = true;
  btn.textContent = 'Updating...';
  status.textContent = 'Running update...';

  logSection.classList.remove('hidden');
  logOutput.textContent = 'Starting update...\n';

  try {
    const response = await fetch('/api/settings/update', { method: 'POST' });
    const data = await response.json();

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

    logOutput.textContent = output;

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
    logOutput.textContent += `\nError: ${/** @type {Error} */ (error).message}`;
  }

  btn.disabled = false;
  btn.textContent = 'Update Application';
}

async function resetSettings() {
  if (!confirm('Are you sure you want to reset all settings to defaults?')) {
    return;
  }

  try {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aws_profile: 'default',
        aws_region: 'us-west-2',
        s3_bucket: '',
        default_upload_folder: '',
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to reset settings');
    }

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
    const response = await fetch('/api/settings/cache/stats');
    const data = await response.json();

    if (data.success && data.stats) {
      const stats = data.stats;

      const cacheTotal = document.getElementById('cache-total');
      if (cacheTotal) cacheTotal.textContent = String(stats.total_entries || 0);

      const cacheExists = document.getElementById('cache-exists');
      if (cacheExists) cacheExists.textContent = String(stats.exists_count || 0);

      const cacheDeleted = document.getElementById('cache-deleted');
      if (cacheDeleted) cacheDeleted.textContent = String(stats.not_exists_count || 0);

      const cacheLastSync = document.getElementById('cache-last-sync');
      if (cacheLastSync) {
        if (stats.last_full_sync) {
          const syncDate = new Date(stats.last_full_sync);
          cacheLastSync.textContent = syncDate.toLocaleString();
        } else {
          cacheLastSync.textContent = 'Never';
        }
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

  btn.disabled = true;
  btn.textContent = 'Syncing...';
  status.classList.remove('hidden');
  status.textContent = 'Fetching file list from S3...';
  status.className = 'mt-2 text-sm text-gray-600';

  try {
    const response = await fetch('/api/settings/cache/sync', { method: 'POST' });
    const data = await response.json();

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

  btn.disabled = false;
  btn.textContent = 'Sync Cache with AWS';
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
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = 'Clearing...';

  try {
    const response = await fetch('/api/settings/cache/invalidate', { method: 'POST' });
    const data = await response.json();

    if (data.success) {
      showNotification(data.message, 'success');
      loadCacheStats();
    } else {
      showNotification(data.error || 'Failed to clear cache', 'error');
    }
  } catch (error) {
    showNotification(/** @type {Error} */ (error).message, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Clear Upload Cache';
}
