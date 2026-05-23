import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  GitBranch,
  Loader2,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { apiPost } from '../../api/client.ts';
import { useAppStore } from '../../stores/appStore.ts';
import type { UpdateResult } from '../../types/api.ts';
import Modal from '../common/Modal.tsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

const GITHUB_ISSUES = 'https://github.com/MODAQ2/modaq_upload/issues';

// ── Step progress display ─────────────────────────────────────────────────────

type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

interface StepRowProps {
  label: string;
  status: StepStatus;
  output?: string;
  showDetails: boolean;
}

function StepRow({ label, status, output, showDetails }: StepRowProps) {
  const icon = {
    pending: <span className="w-4 h-4 rounded-full border-2 border-gray-300 inline-block" />,
    running: <Loader2 className="w-4 h-4 text-nlr-blue animate-spin" />,
    done: <CheckCircle2 className="w-4 h-4 text-green-500" />,
    failed: <XCircle className="w-4 h-4 text-red-500" />,
    skipped: (
      <span className="w-4 h-4 rounded-full border-2 border-gray-200 inline-block opacity-40" />
    ),
  }[status];

  const textColor = {
    pending: 'text-gray-400',
    running: 'text-nlr-text font-medium',
    done: 'text-gray-500',
    failed: 'text-red-600 font-medium',
    skipped: 'text-gray-300',
  }[status];

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <span className="flex-shrink-0">{icon}</span>
        <span className={`text-sm ${textColor}`}>{label}</span>
      </div>
      {showDetails && output && status !== 'pending' && status !== 'skipped' && (
        <pre className="ml-7 text-xs text-gray-400 bg-gray-900 rounded p-2 whitespace-pre-wrap overflow-auto max-h-24">
          {output}
        </pre>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function UpdateModal() {
  const {
    showUpdateModal,
    closeUpdateModal,
    autoCheckResult,
    branchInfo,
    switchBranch,
    refreshBranchInfo,
    rollbackUpdate,
    addNotification,
    loadVersion,
    version,
  } = useAppStore();

  // Update flow
  const [phase, setPhase] = useState<
    'idle' | 'updating' | 'success' | 'failed' | 'rolledback' | 'rollback_failed'
  >('idle');
  const [updateResult, setUpdateResult] = useState<UpdateResult | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [runningStep, setRunningStep] = useState<string | null>(null);

  // Branch / channel
  const [channelOpen, setChannelOpen] = useState(false);
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
  const [switchDone, setSwitchDone] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const isUpdating = phase === 'updating';
  const updatesAvailable = autoCheckResult?.updates_available ?? false;
  const remoteVersion = autoCheckResult?.remote_version;
  const currentVersion = version?.version;
  const currentBranch = branchInfo?.current ?? null;
  const branches = branchInfo?.branches ?? [];

  // ── Compute step statuses from result ──
  function getStepStatuses(result: UpdateResult | null): Record<string, StepStatus> {
    const order = result?.step_order ?? [
      'git_pull',
      'pip_install',
      'modaq_toolkit',
      'npm_install',
      'frontend_build',
    ];
    const statuses: Record<string, StepStatus> = {};
    let hitFailed = false;
    for (const key of order) {
      if (hitFailed) {
        statuses[key] = 'skipped';
        continue;
      }
      const step = result?.results[key];
      if (!step) {
        statuses[key] = runningStep === key ? 'running' : 'pending';
      } else if (step.success) {
        statuses[key] = 'done';
      } else {
        statuses[key] = 'failed';
        hitFailed = true;
      }
    }
    return statuses;
  }

  const defaultLabels: Record<string, string> = {
    git_pull: 'Downloading update',
    pip_install: 'Installing Python packages',
    modaq_toolkit: 'Updating data tools',
    npm_install: 'Installing app dependencies',
    frontend_build: 'Rebuilding interface',
  };

  // ── Handlers ──

  async function handleUpdate() {
    setPhase('updating');
    setUpdateResult(null);
    setRunningStep('git_pull');
    try {
      const result = await apiPost<UpdateResult>('/api/settings/update');
      setUpdateResult(result);
      setRunningStep(null);
      if (result.success) {
        setPhase('success');
        loadVersion();
      } else {
        setPhase('failed');
        addNotification('warning', "Update didn't complete — attempting rollback…");
        // Auto rollback
        if (result.pre_update_commit) {
          const rb = await rollbackUpdate(result.pre_update_commit);
          if (rb.success) {
            setPhase('rolledback');
            loadVersion();
          } else {
            setPhase('rollback_failed');
          }
        }
      }
    } catch {
      setRunningStep(null);
      setPhase('failed');
      addNotification('error', 'Failed to run update');
    }
  }

  async function handleSwitchBranch(branch: string) {
    setSwitchingBranch(branch);
    setSwitchDone(null);
    setSwitchError(null);
    try {
      const result = await switchBranch(branch);
      if (result.success) {
        setSwitchDone(branch);
        addNotification('success', `Switched to ${branchLabel(branch).label} — reload to apply`);
        await refreshBranchInfo();
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

  function handleClose() {
    if (isUpdating) return; // locked during update
    closeUpdateModal();
  }

  const stepStatuses = getStepStatuses(phase === 'idle' ? null : updateResult);
  const stepOrder = updateResult?.step_order ?? [
    'git_pull',
    'pip_install',
    'modaq_toolkit',
    'npm_install',
    'frontend_build',
  ];

  // ── Render ──

  return (
    <Modal
      isOpen={showUpdateModal}
      onClose={handleClose}
      title="Software Update"
      maxWidth="max-w-xl"
      locked={isUpdating}
      footer={
        <div className="flex items-center gap-3 w-full">
          {/* Report a problem — low emphasis */}
          <a
            href={GITHUB_ISSUES}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-gray-400 hover:text-nlr-blue flex items-center gap-1 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            Report a problem
          </a>

          <span className="flex-grow" />

          {phase === 'idle' && (
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
            >
              Later
            </button>
          )}

          {phase === 'idle' && updatesAvailable && (
            <button
              type="button"
              onClick={handleUpdate}
              className="px-5 py-2 text-sm font-semibold text-white bg-nlr-blue rounded-md hover:bg-nlr-blue-light transition-colors"
            >
              Update now
            </button>
          )}

          {phase === 'idle' && !updatesAvailable && (
            <button
              type="button"
              onClick={handleClose}
              className="px-5 py-2 text-sm font-semibold text-white bg-nlr-blue rounded-md hover:bg-nlr-blue-light transition-colors"
            >
              Done
            </button>
          )}

          {phase === 'updating' && (
            <span className="text-xs text-gray-500 italic">Please keep this window open…</span>
          )}

          {phase === 'success' && (
            <>
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
              >
                Later
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-5 py-2 text-sm font-semibold text-white bg-green-600 rounded-md hover:bg-green-700 transition-colors"
              >
                Reload now
              </button>
            </>
          )}

          {(phase === 'rolledback' || phase === 'rollback_failed' || phase === 'failed') && (
            <button
              type="button"
              onClick={handleClose}
              className="px-5 py-2 text-sm font-semibold text-white bg-nlr-blue rounded-md hover:bg-nlr-blue-light transition-colors"
            >
              Close
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {/* ── Version summary card ── */}
        <div className="rounded-lg bg-gray-50 border border-gray-200 p-4">
          {phase === 'idle' && updatesAvailable && (
            <>
              <p className="text-sm font-semibold text-nlr-text">
                A new version of MODAQ Uploader is available.
              </p>
              <div className="mt-2 flex items-center gap-6 text-xs text-gray-500">
                <span>
                  Current:{' '}
                  <strong className="font-mono text-gray-700">v{currentVersion ?? '—'}</strong>
                </span>
                {remoteVersion && (
                  <span>
                    Available: <strong className="font-mono text-nlr-blue">v{remoteVersion}</strong>
                  </span>
                )}
              </div>
              <p className="mt-3 text-xs text-gray-500">
                Your current version will be saved before updating. If anything goes wrong, MODAQ
                Uploader will automatically restore the previous version.
              </p>
            </>
          )}

          {phase === 'idle' && !updatesAvailable && (
            <p className="text-sm font-semibold text-green-700 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              You're using the latest version of MODAQ Uploader.
              {currentVersion && (
                <span className="font-mono text-xs font-normal text-gray-500 ml-1">
                  v{currentVersion}
                </span>
              )}
            </p>
          )}

          {phase === 'updating' && (
            <p className="text-sm font-semibold text-nlr-text flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-nlr-blue animate-spin" />
              Updating MODAQ Uploader…
            </p>
          )}

          {phase === 'success' && (
            <p className="text-sm font-semibold text-green-700 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              Update complete.
              {remoteVersion && (
                <span className="font-mono text-xs font-normal ml-1">
                  v{remoteVersion} is ready.
                </span>
              )}
            </p>
          )}

          {phase === 'rolledback' && (
            <div className="space-y-1">
              <p className="text-sm font-semibold text-amber-700 flex items-center gap-2">
                <RotateCcw className="w-4 h-4" />
                Update didn't complete — your previous version was restored.
              </p>
              <p className="text-xs text-gray-500">
                MODAQ Uploader is still safe to use
                {currentVersion ? ` on v${currentVersion}` : ''}.
              </p>
            </div>
          )}

          {phase === 'rollback_failed' && (
            <div className="space-y-1">
              <p className="text-sm font-semibold text-red-700 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                Update didn't complete.
              </p>
              <p className="text-xs text-gray-600">
                We could not automatically restore the previous version. Please{' '}
                <a
                  href={GITHUB_ISSUES}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-nlr-blue underline"
                >
                  report a problem
                </a>{' '}
                or contact support.
              </p>
            </div>
          )}

          {phase === 'failed' && !updateResult?.pre_update_commit && (
            <div className="space-y-1">
              <p className="text-sm font-semibold text-red-700 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                Update didn't complete.
              </p>
              <p className="text-xs text-gray-500">
                The previous version is still intact. Please{' '}
                <a
                  href={GITHUB_ISSUES}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-nlr-blue underline"
                >
                  report a problem
                </a>{' '}
                if this keeps happening.
              </p>
            </div>
          )}
        </div>

        {/* ── Step progress (shown during and after update) ── */}
        {phase !== 'idle' && (
          <div className="space-y-2">
            {stepOrder.map((key) => {
              const step = updateResult?.results[key];
              const label = step?.label ?? defaultLabels[key] ?? key;
              const status: StepStatus =
                phase === 'updating' && runningStep === key
                  ? 'running'
                  : (stepStatuses[key] ?? 'pending');
              return (
                <StepRow
                  key={key}
                  label={label}
                  status={status}
                  output={step?.output}
                  showDetails={showDetails}
                />
              );
            })}

            {/* Details toggle */}
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="mt-1 text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 transition-colors"
            >
              {showDetails ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
              {showDetails ? 'Hide technical details' : 'Show technical details'}
            </button>
          </div>
        )}

        {/* Success reload hint */}
        {phase === 'success' && (
          <p className="text-sm text-gray-600">
            Reload MODAQ Uploader to start using the new version.
          </p>
        )}

        {/* ── Advanced: Update channel ── */}
        {!isUpdating && (
          <div className="border border-gray-200 rounded-md overflow-hidden">
            <button
              type="button"
              onClick={() => setChannelOpen((o) => !o)}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 text-sm font-medium text-nlr-text transition-colors"
            >
              <span className="flex items-center gap-2">
                <GitBranch className="w-4 h-4 text-gray-400" />
                <span className="text-gray-600">Advanced options</span>
                {currentBranch && (
                  <span className="text-xs text-gray-400 font-normal">
                    — {branchLabel(currentBranch).label}
                  </span>
                )}
              </span>
              {channelOpen ? (
                <ChevronUp className="w-4 h-4 text-gray-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-gray-400" />
              )}
            </button>

            {channelOpen && (
              <div className="px-4 py-3 space-y-3">
                <p className="text-xs text-gray-500">
                  <strong>Update channel</strong> — choose which version of MODAQ Uploader you
                  receive. Switching will take effect after you reload the page.
                </p>

                <div className="divide-y divide-gray-100 border border-gray-100 rounded-md overflow-hidden">
                  {branches.map((branch) => {
                    const isCurrent = branch === currentBranch;
                    const isSwitching = switchingBranch === branch;
                    const isSwitchDone = switchDone === branch;
                    const { label, badge } = branchLabel(branch);
                    return (
                      <div
                        key={branch}
                        className={`flex items-center justify-between px-3 py-2.5 ${
                          isCurrent ? 'bg-nlr-blue/5' : 'hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {isCurrent && (
                            <CheckCircle2 className="w-3.5 h-3.5 text-nlr-blue flex-shrink-0" />
                          )}
                          <div>
                            <span
                              className={`text-sm ${isCurrent ? 'text-nlr-blue font-semibold' : 'text-gray-700'}`}
                            >
                              {label}
                            </span>
                            {badge && (
                              <span className="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200">
                                {badge}
                              </span>
                            )}
                          </div>
                        </div>
                        {!isCurrent && (
                          <button
                            type="button"
                            onClick={() => handleSwitchBranch(branch)}
                            disabled={switchingBranch !== null}
                            className="text-xs text-nlr-blue hover:underline disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                          >
                            {isSwitching ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : isSwitchDone ? (
                              <>
                                <CheckCircle2 className="w-3 h-3 text-green-500" /> Switched
                              </>
                            ) : (
                              'Switch'
                            )}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {switchError && (
                  <p className="text-xs text-red-600 flex items-center gap-1">
                    <XCircle className="w-3.5 h-3.5" /> {switchError}
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
        )}
      </div>
    </Modal>
  );
}
