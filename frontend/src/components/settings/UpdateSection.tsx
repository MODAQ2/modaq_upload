import { CheckCircle2, ChevronDown, ChevronUp, Loader2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../../api/client.ts';
import { useAppStore } from '../../stores/appStore.ts';
import type { UpdateCheckResult, UpdateResult } from '../../types/api.ts';
import { ExternalLinkIcon } from '../../utils/icons.tsx';

const GITHUB_ISSUES = 'https://github.com/MODAQ2/modaq_upload/issues';

const defaultLabels: Record<string, string> = {
  git_pull: 'Downloading update',
  pip_install: 'Installing Python packages',
  modaq_toolkit: 'Updating data tools',
  npm_install: 'Installing app dependencies',
  frontend_build: 'Rebuilding interface',
};

export default function UpdateSection() {
  const { version, loadVersion, addNotification } = useAppStore();

  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateResult | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    loadVersion();
  }, [loadVersion]);

  async function handleCheckUpdates() {
    setChecking(true);
    setCheckResult(null);
    try {
      const result = await apiGet<UpdateCheckResult>('/api/settings/check-updates');
      setCheckResult(result);
    } catch {
      addNotification('error', 'Failed to check for updates');
    } finally {
      setChecking(false);
    }
  }

  async function handleUpdate() {
    setUpdating(true);
    setUpdateResult(null);
    try {
      const result = await apiPost<UpdateResult>('/api/settings/update');
      setUpdateResult(result);
      if (result.success) {
        addNotification('success', 'Update complete — reload to use the new version');
        loadVersion();
      } else {
        addNotification('warning', "Update didn't complete — your previous version is intact");
      }
    } catch {
      addNotification('error', 'Failed to update application');
    } finally {
      setUpdating(false);
    }
  }

  const stepOrder = updateResult?.step_order ?? [];

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold text-nlr-text mb-4">Software Update</h3>

      {/* Version info grid */}
      {version && (
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="bg-gray-50 rounded-md p-3">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Current Version</div>
            <div className="text-sm font-mono font-medium text-nlr-text mt-1">
              v{version.version}
            </div>
          </div>
          <div className="bg-gray-50 rounded-md p-3">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Commit</div>
            <div className="text-sm font-mono font-medium text-nlr-text mt-1">
              {version.commit.slice(0, 7)}
              {version.dirty && <span className="text-nlr-yellow ml-1">(dirty)</span>}
            </div>
          </div>
          <div className="bg-gray-50 rounded-md p-3">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Update Channel</div>
            <div className="text-sm font-mono font-medium text-nlr-text mt-1">{version.branch}</div>
          </div>
        </div>
      )}

      {/* Update check result */}
      {checkResult && (
        <div
          className={`mb-4 p-3 rounded-md text-sm ${
            checkResult.updates_available
              ? 'bg-nlr-yellow/10 text-nlr-text border border-nlr-yellow/30'
              : 'bg-green-50 text-green-800 border border-green-200'
          }`}
        >
          {checkResult.updates_available ? (
            <span>
              A new version is available
              {checkResult.remote_version && (
                <>
                  {' '}
                  — <strong className="font-mono">v{checkResult.remote_version}</strong>
                </>
              )}
              . Your current version will be saved before updating and automatically restored if
              anything goes wrong.
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              You're using the latest version of MODAQ Uploader.
            </span>
          )}
        </div>
      )}

      {/* Step progress */}
      {updateResult && (
        <div className="mb-4 space-y-2">
          {stepOrder.map((key) => {
            const step = updateResult.results[key];
            const label = step?.label ?? defaultLabels[key] ?? key;
            return (
              <div key={key} className="space-y-1">
                <div className="flex items-center gap-3 text-sm">
                  {!step ? (
                    <span className="w-4 h-4 rounded-full border-2 border-gray-200 flex-shrink-0 opacity-40" />
                  ) : step.success ? (
                    <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                  )}
                  <span
                    className={
                      step?.success === false ? 'text-red-600 font-medium' : 'text-gray-600'
                    }
                  >
                    {label}
                  </span>
                </div>
                {showDetails && step?.output && (
                  <pre className="ml-7 text-xs text-gray-400 bg-gray-900 rounded p-2 whitespace-pre-wrap overflow-auto max-h-24">
                    {step.output}
                  </pre>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 transition-colors"
          >
            {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showDetails ? 'Hide technical details' : 'Show technical details'}
          </button>
        </div>
      )}

      {updateResult?.success && (
        <div className="mb-4 flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-md text-sm text-green-800">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          Update complete. Reload MODAQ Uploader to start using the new version.
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="ml-auto px-3 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition-colors"
          >
            Reload now
          </button>
        </div>
      )}

      {/* Buttons */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={handleCheckUpdates}
          disabled={checking || updating}
          className="px-4 py-2 text-sm font-medium text-nlr-blue border border-nlr-blue rounded-md hover:bg-nlr-blue hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
        >
          {checking && <Loader2 className="w-4 h-4 animate-spin" />}
          {checking ? 'Checking…' : 'Check for updates'}
        </button>

        {checkResult?.updates_available && !updateResult?.success && (
          <button
            type="button"
            onClick={handleUpdate}
            disabled={updating}
            className="px-4 py-2 text-sm font-medium text-white bg-nlr-blue rounded-md hover:bg-nlr-blue-light disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {updating && <Loader2 className="w-4 h-4 animate-spin" />}
            {updating ? 'Updating…' : 'Update now'}
          </button>
        )}

        <a
          href={GITHUB_ISSUES}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-xs text-gray-400 hover:text-nlr-blue flex items-center gap-1 transition-colors"
        >
          <ExternalLinkIcon className="w-3 h-3" />
          Report a problem
        </a>
      </div>
    </div>
  );
}
