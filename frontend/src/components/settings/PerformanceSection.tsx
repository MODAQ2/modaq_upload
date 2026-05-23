/**
 * Performance settings section for batch processing configuration.
 *
 * Allows users to configure:
 * - Skip MCAP validation (fast filename-only parsing)
 * - Batch size for large uploads
 * - Auto-tune workers based on CPU
 * - Max worker count
 *
 * Settings auto-save after changes (debounced for continuous inputs like sliders).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore.ts';
import type { BatchProcessingSettings, ValueSource } from '../../types/api.ts';
import { CheckIcon, InfoIcon, SpinnerIcon } from '../../utils/icons.tsx';

function SectionSourceNote({ source }: { source?: ValueSource }) {
  if (!source || source.source === 'builtin') return null;

  if (source.source === 'settings_file' || source.source === 'default_file') {
    const filename = source.path?.split('/').pop() ?? source.path ?? '';
    const label =
      source.source === 'default_file' ? `Default values — ${filename}` : `Saved in ${filename}`;
    return (
      <p className="text-xs text-gray-400" title={source.path}>
        {label}
      </p>
    );
  }

  return null; // batch_processing has no env override support
}

function getDefaultSettings(): BatchProcessingSettings {
  return {
    enabled: true,
    batch_size: 100,
    auto_tune_workers: true,
    max_workers: 4,
    target_cpu_percent: 70.0,
    skip_mcap_validation: false,
    use_database_for_large_jobs: true,
    large_job_threshold: 1000,
  };
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export default function PerformanceSection() {
  const { settings: appSettings, updateSettings } = useAppStore();
  const batchSource = appSettings?.value_sources?.batch_processing;

  const [settings, setSettings] = useState<BatchProcessingSettings>(
    appSettings?.batch_processing ?? getDefaultSettings(),
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  // Track whether a change originated from the user (vs. store sync).
  const userChangedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-sync from the store when settings are loaded externally (e.g. page
  // navigation reload), but only when there is no pending user change.
  useEffect(() => {
    if (appSettings?.batch_processing && !userChangedRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from API response, guarded by userChangedRef
      setSettings(appSettings.batch_processing);
    }
  }, [appSettings]);

  // Cleanup timers on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const save = useCallback(
    async (toSave: BatchProcessingSettings) => {
      setSaveStatus('saving');
      try {
        await updateSettings({ batch_processing: toSave });
        userChangedRef.current = false;
        setSaveStatus('saved');
        // Clear "saved" indicator after 2 seconds.
        savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
      } catch {
        setSaveStatus('error');
      }
    },
    [updateSettings],
  );

  function handleChange(field: keyof BatchProcessingSettings, value: unknown) {
    const next = { ...settings, [field]: value };
    setSettings(next);
    userChangedRef.current = true;

    // Debounce the save so continuous inputs (sliders) don't fire on every tick.
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    debounceRef.current = setTimeout(() => save(next), 600);
  }

  async function handleReset() {
    const defaults = getDefaultSettings();
    setSettings(defaults);
    userChangedRef.current = true;
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    await save(defaults);
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-baseline justify-between mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold text-nlr-text">Performance</h3>
          {saveStatus === 'saving' && (
            <span className="flex items-center gap-1 text-xs text-gray-400">
              <SpinnerIcon className="w-3 h-3 animate-spin" />
              Saving...
            </span>
          )}
          {saveStatus === 'saved' && (
            <span className="flex items-center gap-1 text-xs text-green-600">
              <CheckIcon className="w-3 h-3" />
              Saved
            </span>
          )}
          {saveStatus === 'error' && <span className="text-xs text-red-600">Save failed</span>}
        </div>
        <SectionSourceNote source={batchSource} />
      </div>

      <div className="space-y-6">
        {/* Skip MCAP Validation */}
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="skip_mcap_validation"
            checked={settings.skip_mcap_validation}
            onChange={(e) => handleChange('skip_mcap_validation', e.target.checked)}
            className="mt-1 h-4 w-4 text-nlr-blue border-gray-300 rounded focus:ring-nlr-blue"
          />
          <div className="flex-1">
            <label
              htmlFor="skip_mcap_validation"
              className="text-sm font-medium text-gray-700 cursor-pointer"
            >
              Skip MCAP Validation (Fast Mode)
            </label>
            <p className="text-xs text-gray-500 mt-1">
              Extract timestamps from filenames only (3000x faster). Use when filenames are
              correctly formatted.
            </p>
          </div>
        </div>

        {/* Batch Size */}
        <div>
          <label htmlFor="batch_size" className="block text-sm font-medium text-gray-700 mb-2">
            Batch Size: <span className="font-semibold">{settings.batch_size}</span>
          </label>
          <input
            type="range"
            id="batch_size"
            min="50"
            max="500"
            step="50"
            value={settings.batch_size}
            onChange={(e) => handleChange('batch_size', Number.parseInt(e.target.value, 10))}
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-nlr-blue"
          />
          <p className="text-xs text-gray-500 mt-1">
            Number of files processed per batch (50-500). Lower values reduce memory usage.
          </p>
        </div>

        {/* Auto-tune Workers */}
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="auto_tune_workers"
            checked={settings.auto_tune_workers}
            onChange={(e) => handleChange('auto_tune_workers', e.target.checked)}
            className="mt-1 h-4 w-4 text-nlr-blue border-gray-300 rounded focus:ring-nlr-blue"
          />
          <div className="flex-1">
            <label
              htmlFor="auto_tune_workers"
              className="text-sm font-medium text-gray-700 cursor-pointer"
            >
              Auto-Tune Workers
            </label>
            <p className="text-xs text-gray-500 mt-1">
              Automatically adjust worker count based on CPU/memory utilization. Recommended for
              large jobs.
            </p>
          </div>
        </div>

        {/* Max Workers */}
        <div>
          <label htmlFor="max_workers" className="block text-sm font-medium text-gray-700 mb-2">
            Max Workers
          </label>
          <input
            type="number"
            id="max_workers"
            min="2"
            max="16"
            value={settings.max_workers}
            onChange={(e) => handleChange('max_workers', Number.parseInt(e.target.value, 10))}
            className="w-32 px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-nlr-blue"
          />
          <p className="text-xs text-gray-500 mt-1">
            Maximum concurrent workers (2-16). Higher values increase throughput but use more
            resources.
          </p>
        </div>

        {/* Large Job Threshold */}
        <div>
          <label
            htmlFor="large_job_threshold"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            Large Job Threshold
          </label>
          <input
            type="number"
            id="large_job_threshold"
            min="100"
            max="10000"
            step="100"
            value={settings.large_job_threshold}
            onChange={(e) =>
              handleChange('large_job_threshold', Number.parseInt(e.target.value, 10))
            }
            className="w-32 px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-nlr-blue"
          />
          <p className="text-xs text-gray-500 mt-1">
            Jobs with more files than this threshold use batch processing and database storage.
          </p>
        </div>

        {/* Info banner */}
        <div className="flex items-start gap-2 p-3 bg-blue-50 rounded-lg border border-blue-200 text-sm text-blue-700">
          <InfoIcon className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            Batch processing optimizes memory usage and performance for large uploads (1000+ files).
            Results are stored in a database and retrieved on demand.
          </div>
        </div>

        {/* Reset button */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={handleReset}
            className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
          >
            Reset to Defaults
          </button>
        </div>
      </div>
    </div>
  );
}
