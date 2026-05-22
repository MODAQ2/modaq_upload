/**
 * Upload page — the 4-step upload workflow with a unified file table.
 *
 * Step 1: FolderBrowser — select a folder of Data Files
 * Steps 2-4: Unified table that persists across Review, Upload, and Summary,
 *   with phase-aware header, toolbar, and footer.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import Spinner from '../components/common/Spinner.tsx';
import ActiveFilesList from '../components/upload/ActiveFilesList.tsx';
import BatchProgress from '../components/upload/BatchProgress.tsx';
import CancelConfirmModal from '../components/upload/CancelConfirmModal.tsx';
import ConfirmModal from '../components/upload/ConfirmModal.tsx';
import type { FolderExclusions } from '../components/upload/FolderBrowser.tsx';
import FolderBrowser from '../components/upload/FolderBrowser.tsx';
import LargeFolderSuggestionModal, {
  LARGE_FOLDER_THRESHOLD,
} from '../components/upload/LargeFolderSuggestionModal.tsx';
import ReviewToolbar, { StatusFilterBar } from '../components/upload/ReviewToolbar.tsx';
import ScanProgressModal from '../components/upload/ScanProgressModal.tsx';
import Stepper from '../components/upload/Stepper.tsx';
import UnifiedFileTable from '../components/upload/UnifiedFileTable.tsx';
import UploadFooter from '../components/upload/UploadFooter.tsx';
import UploadHeader from '../components/upload/UploadHeader.tsx';
import { useFileStore } from '../hooks/useFileStore.ts';
import { useFolderScan } from '../hooks/useFolderScan.ts';
import { useUploadJob } from '../hooks/useUploadJob.ts';
import { useAppStore } from '../stores/appStore.ts';
import { type UploadStep, useUploadStore } from '../stores/uploadStore.ts';
import type { FileUploadState, ScannedFileInfo } from '../types/api.ts';
import type { StatusFilter, UploadPhase } from '../types/upload.ts';
import { downloadUploadCsv } from '../utils/csv.ts';

export default function UploadPage() {
  const {
    step,
    setStep,
    folderPath,
    setFolderPath,
    scanFolders,
    completedJob,
    batchState,
    isBatchProcessing,
    reset,
  } = useUploadStore();

  const defaultUploadFolder = useAppStore((s) => s.settings?.default_upload_folder);

  const { startScan, cancelScan, isScanning, scanComplete, folders, foldersTotal, totals } =
    useFolderScan();

  // Unified file store
  const { files, store } = useFileStore();

  // SSE callback: map each file event to the FileStore
  const handleFileUpdate = useCallback(
    (file: FileUploadState) => {
      const statusMap: Record<
        string,
        'in_progress' | 'completed' | 'skipped' | 'failed' | 'queued'
      > = {
        analyzing: 'in_progress',
        uploading: 'in_progress',
        completed: 'completed',
        skipped: 'skipped',
        failed: 'failed',
        cancelled: 'failed',
      };
      store.updateFile(file.local_path, {
        status: statusMap[file.status] ?? 'queued',
        progressPercent: file.progress_percent,
        s3Path: file.s3_path || undefined,
        error: file.error_message || undefined,
        duration: file.upload_duration_seconds,
        speed: file.upload_speed_mbps,
      });
    },
    [store],
  );

  // SSE callback: merge full completion data into the FileStore
  const handleCompletion = useCallback(
    (completionFiles: FileUploadState[]) => {
      store.mergeCompletion(completionFiles);
    },
    [store],
  );

  const uploadJob = useUploadJob({
    onFileUpdate: handleFileUpdate,
    onCompletion: handleCompletion,
  });

  // Local state
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [pendingSelectedPaths, setPendingSelectedPaths] = useState<string[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [showLargeFolderModal, setShowLargeFolderModal] = useState(false);

  // Delay scan modal by 500 ms — fast/cached scans complete before the timer
  // fires, so the modal never flashes for them.
  const [showScanModal, setShowScanModal] = useState(false);
  useEffect(() => {
    if (!isScanning) {
      setShowScanModal(false);
      return;
    }
    const timer = setTimeout(() => setShowScanModal(true), 500);
    return () => clearTimeout(timer);
  }, [isScanning]);

  // Derive phase from step
  const phase: UploadPhase = step <= 2 ? 'review' : step === 3 ? 'uploading' : 'summary';

  // ── Freeze/unfreeze sort on phase transitions ──

  useEffect(() => {
    if (step === 3) store.freezeSort();
    if (step === 4) store.unfreezeSort();
  }, [step, store]);

  // ── Step transitions ──

  /** Step 1: User selected a folder. Start scanning (stay on Step 1 while scanning). */
  const handleFolderSelected = useCallback(
    async (path: string, exclusions?: FolderExclusions) => {
      store.clear();
      setFolderPath(path);
      // Stay on Step 1 while scanning - auto-advance when complete
      await startScan(path, false, exclusions);
    },
    [setFolderPath, startScan, store],
  );

  /** Auto-advance to Step 2 when scan completes.
   *
   * We populate the FileStore here, right before advancing, because by the time
   * scanComplete becomes true the folders array reference has already settled —
   * any render-time ref-comparison trick would have already consumed the change
   * while step was still 1 and skipped the buildFromScan call.
   */
  useEffect(() => {
    if (step === 1 && scanComplete && folders.length > 0) {
      store.buildFromScan(folders);
      const newSelected = new Set<string>();
      for (const folder of folders) {
        for (const file of folder.files) {
          if (!file.already_uploaded) {
            newSelected.add(file.path);
          }
        }
      }
      setSelectedPaths(newSelected);
      // Show large-folder suggestion if total exceeds threshold
      if (totals.totalFiles >= LARGE_FOLDER_THRESHOLD) {
        setShowLargeFolderModal(true);
      }
      setStep(2);
    }
  }, [step, scanComplete, folders, store, setStep, totals.totalFiles]);

  /** Step 2: User clicks "Start Upload" — show confirmation modal. */
  const handleStartUploadClick = useCallback(() => {
    setPendingSelectedPaths(Array.from(selectedPaths));
    setShowConfirmModal(true);
  }, [selectedPaths]);

  /** Confirm modal: Start the actual upload, advance to step 3. */
  const handleConfirmUpload = useCallback(
    async (skipDuplicates: boolean) => {
      setShowConfirmModal(false);
      if (pendingSelectedPaths.length === 0) return;

      // Mark selected files as queued, remove unselected
      store.markSelectedAsPending(new Set(pendingSelectedPaths));
      // Reset filter for upload phase
      store.setFilter('all');
      store.setSearch('');

      setStep(3);
      await uploadJob.startUpload(pendingSelectedPaths, skipDuplicates);
    },
    [pendingSelectedPaths, setStep, uploadJob, store],
  );

  /** Cancel button → show confirmation modal. */
  const handleCancelClick = useCallback(() => {
    setShowCancelModal(true);
  }, []);

  /** Cancel confirmed → send cancel to backend, overlay locks the screen. */
  const handleConfirmCancel = useCallback(async () => {
    setShowCancelModal(false);
    await uploadJob.cancelUpload();
  }, [uploadJob]);

  /** Step 3 -> 4: Upload finished (or cancelled), advance to completion. */
  useEffect(() => {
    if (step === 3 && !uploadJob.isRunning && completedJob) {
      setStep(4);
    }
  }, [step, uploadJob.isRunning, completedJob, setStep]);

  /** Step 4 -> 1: Reset and start over. */
  const handleUploadMore = useCallback(() => {
    store.clear();
    reset();
  }, [reset, store]);

  /** Cancel scan and return to Step 1 if needed. */
  const handleCancelScan = useCallback(async () => {
    await cancelScan();
    // If we're on a later step during scan (shouldn't happen with new flow, but handle it)
    if (step > 1) {
      setStep(1);
    }
  }, [cancelScan, step, setStep]);

  /** Back from step 2 -> step 1. */
  const handleBack = useCallback(async () => {
    if (isScanning) {
      await cancelScan();
    }
    store.clear();
    reset();
  }, [isScanning, cancelScan, reset, store]);

  /** Stepper click — only steps 1 and 2 are clickable, and only when not uploading. */
  const handleStepClick = useCallback(
    (s: UploadStep) => {
      if (s === 1) {
        handleBack();
      } else if (s === 2 && step > 2) {
        setStep(2);
      }
    },
    [handleBack, step, setStep],
  );

  // ── Selection helpers ──

  const toggleFile = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // `files` is listed as a dep to re-derive when the store snapshot changes
  // (store itself is a stable singleton).
  // `files` is a reactive snapshot from useSyncExternalStore — including it as a
  // dep ensures this recomputes whenever the store is mutated (scan populate,
  // SSE updates, etc.).  Without it, `store` never changes reference (singleton)
  // so the memo would always return the empty array from mount time.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `files` is an intentional reactive trigger for the mutable store singleton
  const allFiles = useMemo(() => Array.from(store.getAllRows().values()), [store, files]);

  const toggleAllFiltered = useCallback(() => {
    const filteredPaths = files.map((f) => f.path);
    const allSelected = filteredPaths.every((p) => selectedPaths.has(p));
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      for (const p of filteredPaths) {
        if (allSelected) next.delete(p);
        else next.add(p);
      }
      return next;
    });
  }, [files, selectedPaths]);

  const selectAll = useCallback(() => {
    setSelectedPaths(new Set(allFiles.map((f) => f.path)));
  }, [allFiles]);

  const selectNewOnly = useCallback(() => {
    setSelectedPaths(new Set(allFiles.filter((f) => !f.alreadyUploaded).map((f) => f.path)));
  }, [allFiles]);

  const deselectAll = useCallback(() => {
    setSelectedPaths(new Set());
  }, []);

  const selectFirstN = useCallback(
    (n: number) => {
      const paths = files.slice(0, n).map((f) => f.path);
      setSelectedPaths(new Set(paths));
    },
    [files],
  );

  // ── Header checkbox state ──

  const filteredSelectedCount = files.filter((f) => selectedPaths.has(f.path)).length;
  const headerChecked = files.length > 0 && filteredSelectedCount === files.length;
  const headerIndeterminate = filteredSelectedCount > 0 && filteredSelectedCount < files.length;

  // ── Selected new count (for start upload button) ──

  const selectedNewCount = allFiles.filter(
    (f) => selectedPaths.has(f.path) && !f.alreadyUploaded,
  ).length;

  // ── Confirm modal totals ──

  const selectedTotals = useMemo(() => {
    const selectedSet = new Set(pendingSelectedPaths);
    let totalFiles = 0;
    let alreadyUploaded = 0;
    let totalSize = 0;
    for (const folder of scanFolders) {
      for (const file of folder.files as ScannedFileInfo[]) {
        if (selectedSet.has(file.path)) {
          totalFiles++;
          totalSize += file.size;
          if (file.already_uploaded) alreadyUploaded++;
        }
      }
    }
    return { totalFiles, alreadyUploaded, totalSize };
  }, [pendingSelectedPaths, scanFolders]);

  // ── Filter click handler (from clickable status counters) ──

  const handleFilterClick = useCallback(
    (filter: StatusFilter) => {
      store.setFilter(filter);
    },
    [store],
  );

  // ── CSV download ──

  const handleDownloadCsv = useCallback(() => {
    const jobId = completedJob?.job_id ?? 'unknown';
    downloadUploadCsv(Array.from(store.getAllRows().values()), jobId);
  }, [completedJob, store]);

  // ── Review KPIs: what is actually going to happen when the user clicks Upload ──
  //
  // toUpload    — new selected files (will be sent to S3)
  // uploadSize  — bytes of those new files
  // alreadyOnS3 — selected files already there (will be skipped)
  // totalInFolder — all files found in the scan (context denominator)
  const activeTotals = useMemo(() => {
    let toUpload = 0;
    let uploadSize = 0;
    let alreadyOnS3 = 0;
    for (const file of allFiles) {
      if (selectedPaths.has(file.path)) {
        if (file.alreadyUploaded) {
          alreadyOnS3++;
        } else {
          toUpload++;
          uploadSize += file.size;
        }
      }
    }
    return { toUpload, uploadSize, alreadyOnS3, totalInFolder: allFiles.length };
    // `files` dep ensures we recompute when the store snapshot changes
  }, [allFiles, selectedPaths]);

  // ── Render ──

  return (
    <div>
      <Stepper
        currentStep={step}
        onStepClick={handleStepClick}
        isUploading={step === 3 && uploadJob.isRunning}
      />

      {step === 1 && (
        <FolderBrowser
          onFolderSelected={handleFolderSelected}
          initialPath={folderPath || defaultUploadFolder || undefined}
        />
      )}

      {step >= 2 && (
        <div className="space-y-4">
          {/* Phase-aware header (stat cards / progress / summary) */}
          <UploadHeader
            phase={phase}
            totals={activeTotals}
            isScanning={isScanning}
            foldersFound={folders.length}
            progressPercent={uploadJob.progressPercent}
            filesProcessed={uploadJob.filesProcessed}
            totalFiles={uploadJob.totalFiles}
            statusCounts={uploadJob.statusCounts}
            eta={uploadJob.eta}
            isRunning={uploadJob.isRunning}
            uploadedBytesFormatted={uploadJob.uploadedBytesFormatted}
            totalBytesFormatted={uploadJob.totalBytesFormatted}
            job={completedJob}
            onFilterClick={handleFilterClick}
          />

          {/* Phase-aware toolbar */}
          {phase === 'review' ? (
            <ReviewToolbar
              statusFilter={store.getFilter()}
              onStatusFilterChange={(f) => store.setFilter(f)}
              searchQuery={store.getSearch()}
              onSearchChange={(q) => store.setSearch(q)}
              selectedCount={selectedPaths.size}
              totalCount={store.getSize()}
              filteredCount={files.length}
              showFilteredCount={store.getFilter() !== 'all' || store.getSearch() !== ''}
              onSelectAll={selectAll}
              onSelectNewOnly={selectNewOnly}
              onToggleAllFiltered={toggleAllFiltered}
              onDeselectAll={deselectAll}
              onSelectFirstN={selectFirstN}
              headerChecked={headerChecked}
            />
          ) : (
            <StatusFilterBar
              filter={store.getFilter()}
              onFilterChange={(f) => store.setFilter(f)}
              totalCount={store.getSize()}
              filteredCount={files.length}
              searchQuery={store.getSearch()}
              onSearchChange={(q) => store.setSearch(q)}
            />
          )}

          {/* Top action buttons (review phase only) */}
          {phase === 'review' && (
            <UploadFooter
              phase="review"
              onBack={handleBack}
              onStartUpload={handleStartUploadClick}
              selectedNewCount={selectedNewCount}
            />
          )}

          {/* Batch processing UI for upload phase with large jobs */}
          {phase === 'uploading' && isBatchProcessing ? (
            <>
              <BatchProgress
                batchState={batchState}
                jobProgressPercent={uploadJob.progressPercent}
                jobFilesCompleted={uploadJob.filesProcessed}
                jobFilesTotal={uploadJob.totalFiles}
                jobFilesUploaded={uploadJob.statusCounts.uploaded}
                jobFilesFailed={uploadJob.statusCounts.failed}
                isRunning={uploadJob.isRunning}
              />
              <ActiveFilesList files={uploadJob.activeFiles} />
            </>
          ) : (
            /* The unified file table — stays mounted across phases */
            <UnifiedFileTable
              phase={phase}
              files={files}
              sortKey={store.getSortKey()}
              sortDir={store.getSortDir()}
              onSort={(key) => store.setSort(key)}
              isSortFrozen={store.isFrozen()}
              selectedPaths={selectedPaths}
              onToggleFile={toggleFile}
              onToggleAllFiltered={toggleAllFiltered}
              headerChecked={headerChecked}
              headerIndeterminate={headerIndeterminate}
            />
          )}

          {/* Bottom action buttons */}
          <UploadFooter
            phase={phase}
            onBack={handleBack}
            onStartUpload={handleStartUploadClick}
            selectedNewCount={selectedNewCount}
            onCancel={handleCancelClick}
            isRunning={uploadJob.isRunning && !uploadJob.isCancelling}
            onDownloadCsv={handleDownloadCsv}
            onUploadMore={handleUploadMore}
            failedCount={uploadJob.statusCounts.failed}
          />

          {/* Confirm modal */}
          {step === 2 && (
            <ConfirmModal
              isOpen={showConfirmModal}
              onClose={() => setShowConfirmModal(false)}
              onConfirm={handleConfirmUpload}
              totalFiles={selectedTotals.totalFiles}
              alreadyUploaded={selectedTotals.alreadyUploaded}
              totalSize={selectedTotals.totalSize}
            />
          )}

          {/* Cancel confirmation modal */}
          <CancelConfirmModal
            isOpen={showCancelModal}
            onClose={() => setShowCancelModal(false)}
            onConfirm={handleConfirmCancel}
            filesProcessed={uploadJob.filesProcessed}
            totalFiles={uploadJob.totalFiles}
          />

          {/* Cancelling overlay — locks the screen while backend winds down */}
          {uploadJob.isCancelling && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 backdrop-blur-sm">
              <div className="bg-white rounded-lg shadow-xl px-8 py-6 flex flex-col items-center gap-3">
                <Spinner />
                <p className="text-sm font-medium text-gray-700">Cancelling upload...</p>
                <p className="text-xs text-gray-500">Waiting for in-progress files to finish.</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Scan progress modal - only shown after 500 ms delay so fast/cached
          scans never flash the modal at all. */}
      <ScanProgressModal
        isOpen={showScanModal && !showConfirmModal}
        foldersScanned={folders.length}
        foldersTotal={foldersTotal}
        totalFiles={totals.totalFiles}
        totalSize={totals.totalSize}
        folderPath={folderPath}
        onCancel={handleCancelScan}
      />

      {/* Large folder suggestion modal — shown when scan finds 500+ files */}
      <LargeFolderSuggestionModal
        isOpen={showLargeFolderModal}
        fileCount={totals.totalFiles}
        onContinueAnyway={() => setShowLargeFolderModal(false)}
      />
    </div>
  );
}
