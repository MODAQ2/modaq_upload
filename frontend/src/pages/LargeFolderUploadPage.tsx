/**
 * Large Folder Upload page — runs `aws s3 sync` and streams terminal output.
 *
 * Phase 1a (pick-folder): FolderPicker
 * Phase 1b (name-prefix): S3 destination prefix input
 * Phase 2  (running):     Virtualized terminal + Cancel
 * Phase 3  (done):        Banner + terminal + action buttons
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { cancelLargeFolderSync, startLargeFolderSync } from '../api/largeFolderUpload.ts';
import FolderPicker from '../components/common/FolderPicker.tsx';
import { useAppStore } from '../stores/appStore.ts';
import {
  type SyncProgress,
  type SyncStatus,
  useLargeFolderUploadStore,
} from '../stores/largeFolderUploadStore.ts';
import {
  ChevronRightIcon,
  CloudIcon,
  ErrorIcon,
  FolderIcon,
  SpinnerIcon,
  SuccessIcon,
  UploadIcon,
  WarningIcon,
  XIcon,
} from '../utils/icons.tsx';

// ─── Shared terminal ──────────────────────────────────────────────────────────

/** Virtualized terminal that handles thousands of lines without DOM overflow. */
function Terminal({ lines }: { lines: string[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  // Track whether the user has scrolled away from the bottom
  const atBottomRef = useRef(true);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 10,
  });

  // Auto-scroll only when already pinned to bottom
  useEffect(() => {
    if (atBottomRef.current && lines.length > 0) {
      virtualizer.scrollToIndex(lines.length - 1, { align: 'end' });
    }
  }, [lines.length, virtualizer]);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  return (
    <div
      ref={parentRef}
      onScroll={handleScroll}
      className="bg-gray-950 text-green-400 font-mono text-xs rounded-lg px-4 py-3 h-96 overflow-y-auto"
      aria-label="Sync output"
    >
      {lines.length === 0 ? (
        <span className="text-gray-500 italic leading-5">Waiting for output…</span>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${item.size}px`,
                transform: `translateY(${item.start}px)`,
              }}
              className="leading-5 whitespace-pre truncate"
            >
              {lines[item.index] || '\u00A0'}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

/** Format seconds as M:SS or H:MM:SS */
function formatTimer(secs: number): string {
  const s = Math.floor(secs);
  if (s < 3600) {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function ProgressBar({
  progress,
  uploadStartMs,
}: {
  progress: SyncProgress;
  uploadStartMs: number | null;
}) {
  const { done, total } = progress;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  // Live ticking elapsed & eta — update every second from wall clock
  const [liveElapsedS, setLiveElapsedS] = useState(0);

  useEffect(() => {
    if (uploadStartMs == null) return;
    const tick = () => setLiveElapsedS(Math.round((Date.now() - uploadStartMs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [uploadStartMs]);

  // Only show ETA after 5 files and 10+ seconds (stable estimate)
  const stableEstimate = done >= 5 && liveElapsedS >= 10;
  const liveEtaS =
    stableEstimate && done > 0 && total > done
      ? Math.round((liveElapsedS / done) * (total - done))
      : null;

  return (
    <div className="space-y-2">
      {/* File count + percentage */}
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-nlr-text">
          {done.toLocaleString()} / {total.toLocaleString()} files
        </span>
        <span className="text-gray-500 text-xs">{pct}%</span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
        <div
          className="bg-nlr-blue h-2.5 rounded-full transition-all duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Timer row */}
      <div className="flex items-center justify-between text-sm text-gray-600">
        <span>
          Elapsed time:{' '}
          <span className="font-mono font-semibold text-nlr-text text-base">
            {formatTimer(liveElapsedS)}
          </span>
        </span>
        <span>
          Estimated time remaining:{' '}
          {liveEtaS != null ? (
            <span className="font-mono font-semibold text-nlr-blue text-base">
              {formatTimer(liveEtaS)}
            </span>
          ) : (
            <span className="text-gray-400 italic">Calculating…</span>
          )}
        </span>
      </div>

      <p className="text-xs text-gray-400">Already-uploaded files are skipped automatically.</p>
    </div>
  );
}

// ─── CLI command display ──────────────────────────────────────────────────────

/** Build a preview command from known values before the job starts. */
function buildPreviewCmd(
  folderPath: string,
  s3Prefix: string,
  bucket: string,
  region: string,
  profile: string,
): string {
  const dest = `s3://${bucket}/${s3Prefix.trim().replace(/\/$/, '')}/`;
  const parts = ['aws', 's3', 'sync', folderPath, dest, '--no-progress', '--region', region];
  if (profile && profile !== 'default') parts.push('--profile', profile);
  return parts.join(' ');
}

function CliCommand({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [cmd]);

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
        <span className="text-sm font-medium text-gray-700">
          Run this upload from the command line
        </span>
      </div>

      <div className="p-4 space-y-3 bg-white">
        <p className="text-xs text-gray-500">
          If the upload fails or you need to resume, paste this command in a terminal. It uses your{' '}
          <span className="font-mono">aws</span> credential profile from Settings and will
          automatically skip already-uploaded files.
        </p>

        {/* Command box */}
        <div className="relative">
          <pre className="bg-gray-950 text-green-400 font-mono text-xs rounded-md px-4 py-3 pr-24 whitespace-pre-wrap break-all leading-5">
            {cmd}
          </pre>
          <button
            type="button"
            onClick={handleCopy}
            className="absolute top-2 right-2 px-2.5 py-1 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded transition-colors"
          >
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>

        <p className="text-xs text-gray-500">
          Files already in the destination are automatically skipped — safe to re-run.
        </p>
      </div>
    </div>
  );
}

// ─── Phase components ─────────────────────────────────────────────────────────

function PickFolderStep() {
  const { folderPath, setFolderPath } = useLargeFolderUploadStore();
  const defaultUploadFolder = useAppStore((s) => s.settings?.default_upload_folder);
  const [chosen, setChosen] = useState(folderPath);

  const handleSelect = useCallback((path: string) => {
    setChosen(path);
  }, []);

  const handleConfirm = useCallback(() => {
    if (chosen) setFolderPath(chosen);
  }, [chosen, setFolderPath]);

  return (
    <div className="space-y-4">
      <FolderPicker
        onFolderSelected={handleSelect}
        initialPath={folderPath || defaultUploadFolder || undefined}
      />
      {chosen && (
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handleConfirm}
            className="flex items-center gap-2 bg-nlr-blue text-white px-5 py-2.5 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            Continue with this folder
            <ChevronRightIcon className="w-4 h-4" />
          </button>
          <span className="text-xs text-gray-500 font-mono break-all">{chosen}</span>
        </div>
      )}
    </div>
  );
}

function NamePrefixStep() {
  const { folderPath, s3Prefix, setS3Prefix, setFolderPath, startJob, setError } =
    useLargeFolderUploadStore();
  const settings = useAppStore((s) => s.settings);
  const notifications = useAppStore((s) => s.addNotification);

  const handleBack = useCallback(() => {
    // Return to folder picker — clear folderPath so SetupPhase shows picker again
    setFolderPath('');
  }, [setFolderPath]);

  const handleStart = useCallback(async () => {
    if (!folderPath || !s3Prefix.trim()) {
      notifications('error', 'Folder and S3 prefix are required.');
      return;
    }
    try {
      const { job_id, s3_uri, cmd } = await startLargeFolderSync(folderPath, s3Prefix.trim());
      startJob(job_id, s3_uri, cmd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start upload';
      setError(msg);
    }
  }, [folderPath, s3Prefix, startJob, setError, notifications]);

  return (
    <div className="max-w-2xl space-y-6">
      {/* Source summary */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 flex items-center gap-3">
        <FolderIcon className="w-5 h-5 text-amber-400 flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-xs text-gray-500 mb-0.5">Source folder</p>
          <p className="text-sm font-mono text-gray-800 break-all">{folderPath}</p>
        </div>
      </div>

      {/* Cloud destination prefix */}
      <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <CloudIcon className="w-5 h-5 text-nlr-blue" />
          <h3 className="text-base font-semibold text-nlr-text">
            Name your cloud destination folder
          </h3>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-md px-3 py-2 text-sm text-blue-800">
          <span className="font-semibold">The default name is fine.</span> It's a timestamp so each
          upload gets its own folder in NLR Cloud Storage and nothing gets overwritten. You can
          change it if you're continuing a previous upload or want a friendlier name.
        </div>

        <div>
          <label htmlFor="s3-prefix" className="block text-sm font-medium text-nlr-text mb-1">
            Destination folder name
          </label>
          <input
            id="s3-prefix"
            type="text"
            value={s3Prefix}
            onChange={(e) => setS3Prefix(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-nlr-blue"
            placeholder="user_upload_2025-01-01T12-00-00"
            // biome-ignore lint/a11y/noAutofocus: focus is intentional — user is here to name the folder
            autoFocus
          />
          <p className="text-xs text-gray-400 mt-1">
            Files land at{' '}
            <span className="font-mono">s3://&lt;bucket&gt;/{s3Prefix.trim() || '…'}/</span>
          </p>
        </div>

        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={handleBack}
            className="border border-gray-300 text-gray-600 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            ← Back
          </button>
          <button
            type="button"
            onClick={handleStart}
            disabled={!s3Prefix.trim()}
            className="flex items-center gap-2 bg-nlr-blue text-white px-5 py-2 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            <UploadIcon className="w-4 h-4" />
            Start Upload
          </button>
        </div>

        {/* CLI fallback — preview before job starts */}
        {settings && folderPath && s3Prefix.trim() && (
          <CliCommand
            cmd={buildPreviewCmd(
              folderPath,
              s3Prefix,
              settings.s3_bucket,
              settings.aws_region,
              settings.aws_profile,
            )}
          />
        )}
      </div>
    </div>
  );
}

function SetupPhase() {
  const folderPath = useLargeFolderUploadStore((s) => s.folderPath);
  return folderPath ? <NamePrefixStep /> : <PickFolderStep />;
}

function RunningPhase() {
  const { jobId, s3Uri, lines, status, progress, uploadStartMs, cmd } = useLargeFolderUploadStore();
  const finish = useLargeFolderUploadStore((s) => s.finish);
  const appendLine = useLargeFolderUploadStore((s) => s.appendLine);
  const setProgress = useLargeFolderUploadStore((s) => s.setProgress);
  const setUploadStartMs = useLargeFolderUploadStore((s) => s.setUploadStartMs);
  const esRef = useRef<EventSource | null>(null);
  // "Scanning…" phase before dry-run completes
  const [scanning, setScanning] = useState(true);

  useEffect(() => {
    if (!jobId) return;
    const es = new EventSource(`/api/large-folder-upload/progress/${jobId}`);
    esRef.current = es;

    es.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data as string) as {
          type?: string;
          line?: string;
          status?: SyncStatus;
          return_code?: number | null;
          error?: string;
          total_files?: number;
          done?: number;
          total?: number;
          elapsed_s?: number;
          eta_s?: number | null;
        };

        if (data.type === 'plan') {
          setScanning(false);
          setUploadStartMs(Date.now());
          setProgress({ done: 0, total: data.total_files ?? 0, elapsedS: 0, etaS: null });
        } else if (data.type === 'file_done') {
          appendLine(data.line ?? '');
          setProgress({
            done: data.done ?? 0,
            total: data.total ?? 0,
            elapsedS: data.elapsed_s ?? 0,
            etaS: data.eta_s ?? null,
          });
        } else if (data.type === 'line' && data.line != null) {
          appendLine(data.line);
        } else if (data.type === 'done') {
          finish(data.status ?? 'failed', data.return_code ?? null);
          es.close();
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      finish('failed', null);
      es.close();
    };

    return () => es.close();
  }, [jobId, appendLine, finish, setProgress, setUploadStartMs]);

  const handleCancel = useCallback(async () => {
    if (!jobId) return;
    esRef.current?.close();
    try {
      await cancelLargeFolderSync(jobId);
    } catch {
      finish('cancelled', null);
    }
  }, [jobId, finish]);

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <SpinnerIcon className="w-5 h-5 text-nlr-blue animate-spin" />
          <div>
            <p className="font-semibold text-nlr-text">
              {scanning ? 'Scanning for files to upload…' : 'Upload in progress…'}
            </p>
            {s3Uri && (
              <p className="text-xs text-gray-500 mt-0.5">
                <span className="text-gray-400">NLR Cloud Storage → </span>
                <span className="font-mono">{s3Uri}</span>
              </p>
            )}
          </div>
        </div>
        {status === 'running' && (
          <button
            type="button"
            onClick={handleCancel}
            className="flex items-center gap-1.5 text-sm text-red-600 hover:text-red-800 border border-red-300 hover:border-red-500 px-3 py-1.5 rounded-md transition-colors"
          >
            <XIcon className="w-4 h-4" />
            Cancel
          </button>
        )}
      </div>

      {/* Scanning indeterminate bar */}
      {scanning && (
        <div className="space-y-1.5">
          <p className="text-xs text-gray-500">Counting files to upload…</p>
          <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
            <div className="scanning-bar h-2.5 rounded-full bg-nlr-blue/60" />
          </div>
        </div>
      )}

      {/* Progress bar */}
      {!scanning && progress && <ProgressBar progress={progress} uploadStartMs={uploadStartMs} />}

      <Terminal lines={lines} />

      {cmd && <CliCommand cmd={cmd} />}
    </div>
  );
}

function DonePhase() {
  const { status, lines, s3Uri, folderPath, returnCode, reset, completedElapsedS, progress, cmd } =
    useLargeFolderUploadStore();
  const navigate = useNavigate();

  const isSuccess = status === 'completed';
  const isCancelled = status === 'cancelled';
  const uploadedCount = progress?.done ?? lines.length;

  return (
    <div className="space-y-4">
      <div
        className={`rounded-lg p-5 flex items-start gap-3 border ${
          isSuccess
            ? 'bg-green-50 border-green-200'
            : isCancelled
              ? 'bg-amber-50 border-amber-200'
              : 'bg-red-50 border-red-200'
        }`}
      >
        {isSuccess ? (
          <SuccessIcon className="w-6 h-6 text-green-600 flex-shrink-0 mt-0.5" />
        ) : isCancelled ? (
          <WarningIcon className="w-6 h-6 text-amber-600 flex-shrink-0 mt-0.5" />
        ) : (
          <ErrorIcon className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
        )}
        <div className="space-y-1.5 min-w-0">
          <p
            className={`text-lg font-semibold ${isSuccess ? 'text-green-800' : isCancelled ? 'text-amber-800' : 'text-red-800'}`}
          >
            {isSuccess
              ? `${uploadedCount.toLocaleString()} file${uploadedCount !== 1 ? 's' : ''} uploaded successfully${completedElapsedS != null ? ` in ${formatTimer(completedElapsedS)}` : ''}`
              : isCancelled
                ? 'Upload cancelled'
                : `Upload failed${returnCode != null ? ` (exit code ${returnCode})` : ''}`}
          </p>

          {isSuccess && s3Uri && (
            <div className="mt-2 space-y-1 text-sm">
              <div className="flex items-start gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Source</span>
                <span className="font-mono text-gray-800 break-all">{folderPath}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-gray-500 w-32 flex-shrink-0">Destination</span>
                <div className="min-w-0">
                  <p className="text-xs text-gray-400 mb-0.5">NLR Cloud Storage (MODAQ AWS S3)</p>
                  <span className="font-mono text-nlr-blue break-all">{s3Uri}</span>
                </div>
              </div>
            </div>
          )}

          {!isSuccess && s3Uri && (
            <p className="text-xs font-mono mt-1 text-gray-600 break-all">{s3Uri}</p>
          )}

          <p className="text-xs text-gray-500 pt-1">
            Already-uploaded files were skipped · output saved to the Event Log
          </p>
        </div>
      </div>

      <Terminal lines={lines} />

      {cmd && <CliCommand cmd={cmd} />}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="bg-nlr-blue text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          Start Another Large Upload
        </button>
        <button
          type="button"
          onClick={() => navigate('/logs')}
          className="border border-gray-300 text-nlr-text px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors"
        >
          View in History
        </button>
        <button
          type="button"
          onClick={() => navigate('/files')}
          className="border border-gray-300 text-nlr-text px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors"
        >
          Browse Uploaded Files
        </button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LargeFolderUploadPage() {
  const phase = useLargeFolderUploadStore((s) => s.phase);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <UploadIcon className="w-6 h-6 text-nlr-blue" />
        <h2 className="text-xl font-semibold text-nlr-text">Large Folder Upload</h2>
      </div>

      {/* Info banner — only in setup */}
      {phase === 'setup' && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex gap-3">
          <svg
            className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="text-sm text-blue-800">
            <p className="font-semibold mb-1">Uploads the entire folder to NLR Cloud Storage</p>
            <p>
              Copies all files directly to the MODAQ AWS S3 bucket, preserving your folder structure
              as-is. Already-uploaded files are automatically skipped — no duplicates. Best for 500+
              files where per-file analysis would be slow.
            </p>
          </div>
        </div>
      )}

      {phase === 'setup' && <SetupPhase />}
      {phase === 'running' && <RunningPhase />}
      {phase === 'done' && <DonePhase />}
    </div>
  );
}
