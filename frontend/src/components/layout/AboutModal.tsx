import { useState } from 'react';
import { apiGet, apiPost } from '../../api/client.ts';
import { useAppStore } from '../../stores/appStore.ts';
import type { BranchListResult, UpdateCheckResult, UpdateResult } from '../../types/api.ts';
import Modal from '../common/Modal.tsx';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  RefreshIcon,
  SpinnerIcon,
  XCircleIcon,
} from '../../utils/icons.tsx';
import { CheckCircle2 } from 'lucide-react';

const GITHUB_REPO = 'https://github.com/MODAQ2/modaq_upload';
const GITHUB_ISSUES = `${GITHUB_REPO}/issues`;

function branchLabel(branch: string): { label: string; badge?: string } {
  if (branch === 'main') return { label: 'Stable Release', badge: 'Recommended' };
  if (branch === 'develop') return { label: 'Development Preview' };
  const featMatch = branch.match(/^feat(?:ure)?[_/-](.+)$/);
  if (featMatch) {
    const name = featMatch[1].replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return { label: `Feature Preview: ${name}` };
  }
  const prepMatch = branch.match(/^prep[_/-](.+)$/);
  if (prepMatch) return { label: `Release Prep: ${prepMatch[1]}` };
  return { label: branch };
}

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function AboutModal({ isOpen, onClose }: AboutModalProps) {
  const { version, addNotification, loadVersion } = useAppStore();

  // Collapsible state
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);

  // Update state
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateResult | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  // Branch state
  const [branchInfo, setBranchInfo] = useState<BranchListResult | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
  const [switchDone, setSwitchDone] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  async function handleToggleUpdates() {
    const next = !updatesOpen;
    setUpdatesOpen(next);
    if (next && !checkResult) {
      setChecking(true);
      try {
        const result = await apiGet<UpdateCheckResult>('/api/settings/check-updates');
        setCheckResult(result);
      } catch {
        addNotification('error', 'Failed to check for updates');
      } finally {
        setChecking(false);
      }
    }
  }

  async function handleToggleBranch() {
    const next = !branchOpen;
    setBranchOpen(next);
    if (next && !branchInfo) {
      setLoadingBranches(true);
      try {
        const result = await apiGet<BranchListResult>('/api/settings/branches');
        setBranchInfo(result);
      } catch {
        addNotification('error', 'Failed to load branches');
      } finally {
        setLoadingBranches(false);
      }
    }
  }

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
        addNotification('warning', 'Update didn\'t complete — your previous version is intact');
      }
    } catch {
      addNotification('error', 'Failed to update application');
    } finally {
      setUpdating(false);
    }
  }

  async function handleSwitchBranch(branch: string) {
    setSwitchingBranch(branch);
    setSwitchDone(null);
    setSwitchError(null);
    try {
      const result = await apiPost<{ success: boolean; output: string; error: string | null }>(
        '/api/settings/branches/switch',
        { branch },
      );
      if (result.success) {
        setSwitchDone(branch);
        addNotification('success', `Switched to ${branchLabel(branch).label} — reload to apply`);
        const updated = await apiGet<BranchListResult>('/api/settings/branches');
        setBranchInfo(updated);
      } else {
        setSwitchError(result.error ?? 'Could not switch update channel');
        addNotification('error', 'Could not switch update channel');
      }
    } catch {
      setSwitchError('Unexpected error');
    } finally {
      setSwitchingBranch(null);
    }
  }

  const currentBranch = branchInfo?.current ?? null;
  const branches = branchInfo?.branches ?? [];
  const stepOrder = updateResult?.step_order ?? ['git_pull', 'pip_install', 'modaq_toolkit', 'npm_install', 'frontend_build'];
  const defaultLabels: Record<string, string> = {
    git_pull: 'Downloading update',
    pip_install: 'Installing Python packages',
    modaq_toolkit: 'Updating data tools',
    npm_install: 'Installing app dependencies',
    frontend_build: 'Rebuilding interface',
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="About"
      maxWidth="max-w-lg"
      footer={
        <div className="flex items-center gap-3 w-full">
          <a
            href={GITHUB_ISSUES}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-gray-400 hover:text-nlr-blue flex items-center gap-1 transition-colors"
          >
            <ExternalLinkIcon className="w-3 h-3" />
            Report a problem
          </a>
          <span className="flex-grow" />
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-nlr-gray text-white rounded hover:opacity-90 text-sm"
          >
            Close
          </button>
        </div>
      }
    >
      {/* Version info */}
      <div className="p-3 bg-gray-50 rounded">
        <div className="flex justify-between items-center">
          <span className="text-sm text-gray-500">Version</span>
          <span className="font-mono text-sm font-semibold">
            {version?.version ? `v${version.version}` : 'loading...'}
          </span>
        </div>
        <div className="flex justify-between items-center mt-2">
          <span className="text-sm text-gray-500">Commit</span>
          <span className="font-mono text-sm text-gray-600">
            {version?.commit ? version.commit.slice(0, 7) : '-'}
          </span>
        </div>
        <div className="flex justify-between items-center mt-2">
          <span className="text-sm text-gray-500">Channel</span>
          <span className="font-mono text-sm text-gray-600">
            {version?.branch ? branchLabel(version.branch).label : '-'}
          </span>
        </div>
      </div>

      {/* Links */}
      <div className="mt-4 flex flex-col gap-2">
        <a
          href={GITHUB_REPO}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm text-nlr-blue hover:underline"
        >
          <ExternalLinkIcon className="w-4 h-4 flex-shrink-0" />
          View source on GitHub
        </a>
        <a
          href={GITHUB_ISSUES}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm text-nlr-blue hover:underline"
        >
          <ExternalLinkIcon className="w-4 h-4 flex-shrink-0" />
          Report an issue
        </a>
      </div>

      {/* ── Collapsible: Updates ── */}
      <div className="mt-4 border border-gray-200 rounded-md overflow-hidden">
        <button
          type="button"
          onClick={handleToggleUpdates}
          className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 text-sm font-medium text-nlr-text transition-colors"
        >
          <span className="flex items-center gap-2">
            <RefreshIcon className="w-4 h-4 text-nlr-blue" />
            Software Update
            {checking && <SpinnerIcon className="w-3 h-3 animate-spin text-gray-400" />}
            {checkResult && !checking && (
              <span
                className={`px-2 py-0.5 text-xs rounded-full border ${
                  checkResult.updates_available
                    ? 'bg-nlr-yellow/20 text-nlr-text border-nlr-yellow/40'
                    : 'bg-green-100 text-green-700 border-green-200'
                }`}
              >
                {checkResult.updates_available
                  ? checkResult.remote_version
                    ? `v${checkResult.remote_version} available`
                    : 'Update available'
                  : 'Up to date'}
              </span>
            )}
          </span>
          {updatesOpen ? (
            <ChevronUpIcon className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDownIcon className="w-4 h-4 text-gray-400" />
          )}
        </button>

        {updatesOpen && (
          <div className="px-4 py-3 space-y-3">
            {checking && (
              <p className="text-sm text-gray-500 flex items-center gap-2">
                <SpinnerIcon className="w-4 h-4 animate-spin" /> Checking for updates…
              </p>
            )}

            {checkResult && !checking && (
              <div className="space-y-1">
                {checkResult.updates_available ? (
                  <p className="text-sm text-gray-700">
                    A new version is available
                    {checkResult.remote_version && (
                      <> — <strong className="font-mono">v{checkResult.remote_version}</strong></>
                    )}.
                    {' '}Your current version will be saved before updating, and automatically
                    restored if anything goes wrong.
                  </p>
                ) : (
                  <p className="text-sm text-gray-600 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                    You're using the latest version of MODAQ Uploader.
                  </p>
                )}
              </div>
            )}

            {/* Step progress */}
            {updateResult && (
              <div className="space-y-1.5">
                {stepOrder.map((key) => {
                  const step = updateResult.results[key];
                  const label = step?.label ?? defaultLabels[key] ?? key;
                  const icon = !step ? null
                    : step.success
                      ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                      : <XCircleIcon className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />;
                  return (
                    <div key={key} className="space-y-0.5">
                      <div className="flex items-center gap-2 text-xs text-gray-600">
                        {icon ?? <span className="w-3.5 h-3.5 flex-shrink-0" />}
                        {label}
                      </div>
                      {showDetails && step?.output && (
                        <pre className="ml-5 text-xs text-gray-400 bg-gray-900 rounded p-1.5 whitespace-pre-wrap overflow-auto max-h-16">
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
                  {showDetails ? <ChevronUpIcon className="w-3 h-3" /> : <ChevronDownIcon className="w-3 h-3" />}
                  {showDetails ? 'Hide technical details' : 'Show technical details'}
                </button>
              </div>
            )}

            {updateResult?.success && (
              <div className="flex items-center gap-2 p-2 bg-green-50 border border-green-200 rounded text-xs text-green-800">
                <CheckIcon className="w-3.5 h-3.5 flex-shrink-0" />
                Update complete. Reload to use the new version.
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="ml-auto px-2 py-0.5 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition-colors"
                >
                  Reload now
                </button>
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleCheckUpdates}
                disabled={checking || updating}
                className="px-3 py-1.5 text-xs font-medium text-nlr-blue border border-nlr-blue rounded hover:bg-nlr-blue hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {checking ? 'Checking…' : 'Re-check'}
              </button>
              {checkResult?.updates_available && !updateResult?.success && (
                <button
                  type="button"
                  onClick={handleUpdate}
                  disabled={updating}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-nlr-blue rounded hover:bg-nlr-blue-light disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
                >
                  {updating ? (
                    <><SpinnerIcon className="w-3 h-3 animate-spin" /> Updating…</>
                  ) : (
                    'Update now'
                  )}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Collapsible: Update channel ── */}
      <div className="mt-3 border border-gray-200 rounded-md overflow-hidden">
        <button
          type="button"
          onClick={handleToggleBranch}
          className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 text-sm font-medium text-nlr-text transition-colors"
        >
          <span className="flex items-center gap-2">
            <GitBranchIcon className="w-4 h-4 text-gray-400" />
            <span className="text-gray-600">Update channel</span>
            {loadingBranches && <SpinnerIcon className="w-3 h-3 animate-spin text-gray-400" />}
            {currentBranch && !loadingBranches && (
              <span className="text-xs text-gray-400 font-normal">
                — {branchLabel(currentBranch).label}
              </span>
            )}
          </span>
          {branchOpen ? (
            <ChevronUpIcon className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDownIcon className="w-4 h-4 text-gray-400" />
          )}
        </button>

        {branchOpen && (
          <div className="px-4 py-3 space-y-3">
            {loadingBranches && (
              <p className="text-sm text-gray-500 flex items-center gap-2">
                <SpinnerIcon className="w-4 h-4 animate-spin" /> Loading channels…
              </p>
            )}

            {!loadingBranches && branches.length > 0 && (
              <>
                <p className="text-xs text-gray-500">
                  Choose which version of MODAQ Uploader you receive.
                </p>
                <div className="max-h-40 overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded text-sm">
                  {branches.map((branch) => {
                    const isCurrent = branch === currentBranch;
                    const isSwitching = switchingBranch === branch;
                    const isSwitchDone = switchDone === branch;
                    const { label, badge } = branchLabel(branch);
                    return (
                      <div
                        key={branch}
                        className={`flex items-center justify-between px-3 py-2 ${
                          isCurrent ? 'bg-nlr-blue/5' : 'hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {isCurrent && <CheckCircle2 className="w-3.5 h-3.5 text-nlr-blue flex-shrink-0" />}
                          <span className={`text-sm ${isCurrent ? 'text-nlr-blue font-semibold' : 'text-gray-700'}`}>
                            {label}
                          </span>
                          {badge && (
                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200">
                              {badge}
                            </span>
                          )}
                        </div>
                        {!isCurrent && (
                          <button
                            type="button"
                            onClick={() => handleSwitchBranch(branch)}
                            disabled={switchingBranch !== null}
                            className="text-xs text-nlr-blue hover:underline disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                          >
                            {isSwitching
                              ? <SpinnerIcon className="w-3 h-3 animate-spin inline" />
                              : isSwitchDone
                                ? <><CheckCircle2 className="w-3 h-3 text-green-500 inline" /> Switched</>
                                : 'Switch'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {switchError && (
              <p className="text-xs text-red-600 flex items-center gap-1">
                <XCircleIcon className="w-3.5 h-3.5" /> {switchError}
              </p>
            )}

            {switchDone && (
              <div className="flex items-center gap-2 p-2 bg-green-50 border border-green-200 rounded text-xs text-green-800">
                <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
                Switched to {branchLabel(switchDone).label}.
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="ml-auto px-2 py-0.5 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition-colors"
                >
                  Reload page
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
