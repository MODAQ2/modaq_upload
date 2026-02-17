/**
 * Upload page — the 4-step upload workflow with a unified file table.
 *
 * Step 1: FolderBrowser — select a folder of MCAP files
 * Steps 2-4: Unified table that persists across Review, Upload, and Summary,
 *   with phase-aware header, toolbar, and footer.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";

import ConfirmModal from "../components/upload/ConfirmModal.tsx";
import FolderBrowser from "../components/upload/FolderBrowser.tsx";
import type { FolderExclusions } from "../components/upload/FolderBrowser.tsx";
import ReviewToolbar, { StatusFilterBar } from "../components/upload/ReviewToolbar.tsx";
import Stepper from "../components/upload/Stepper.tsx";
import UnifiedFileTable from "../components/upload/UnifiedFileTable.tsx";
import UploadFooter from "../components/upload/UploadFooter.tsx";
import UploadHeader from "../components/upload/UploadHeader.tsx";
import { useFileStore } from "../hooks/useFileStore.ts";
import { useFolderScan } from "../hooks/useFolderScan.ts";
import { useUploadJob } from "../hooks/useUploadJob.ts";
import { useAppStore } from "../stores/appStore.ts";
import { useUploadStore, type UploadStep } from "../stores/uploadStore.ts";
import type { FileUploadState, ScannedFileInfo } from "../types/api.ts";
import type { StatusFilter, UploadPhase } from "../types/upload.ts";
import { downloadUploadCsv } from "../utils/csv.ts";

export default function UploadPage() {
  const {
    step,
    setStep,
    folderPath,
    setFolderPath,
    scanFolders,
    scanTotals,
    completedJob,
    reset,
  } = useUploadStore();

  const defaultUploadFolder = useAppStore((s) => s.settings?.default_upload_folder);

  const {
    startScan,
    cancelScan,
    isScanning,
    scanComplete,
    folders,
    totals,
  } = useFolderScan();

  const uploadJob = useUploadJob();

  // Unified file store
  const { files, store } = useFileStore();

  // Local state
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [pendingSelectedPaths, setPendingSelectedPaths] = useState<string[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  // Derive phase from step
  const phase: UploadPhase = step <= 2 ? "review" : step === 3 ? "uploading" : "summary";

  // ── Wire SSE callbacks to FileStore (useLayoutEffect to avoid race) ──

  useLayoutEffect(() => {
    uploadJob.onFileUpdate.current = (file: FileUploadState) => {
      const statusMap: Record<string, "in_progress" | "completed" | "skipped" | "failed" | "queued"> = {
        analyzing: "in_progress",
        uploading: "in_progress",
        completed: "completed",
        skipped: "skipped",
        failed: "failed",
        cancelled: "failed",
      };
      store.updateFile(file.local_path, {
        status: statusMap[file.status] ?? "queued",
        progressPercent: file.progress_percent,
        s3Path: file.s3_path || undefined,
        error: file.error_message || undefined,
        duration: file.upload_duration_seconds,
        speed: file.upload_speed_mbps,
      });
    };
    uploadJob.onCompletion.current = (completionFiles: FileUploadState[]) => {
      store.mergeCompletion(completionFiles);
    };
  });

  // ── Sync FileStore from scan data as folders arrive ──

  useEffect(() => {
    if (folders.length > 0 && step >= 2) {
      store.buildFromScan(folders);
      // Auto-select new files
      const newSelected = new Set<string>();
      for (const folder of folders) {
        for (const file of folder.files) {
          if (!file.already_uploaded) {
            newSelected.add(file.path);
          }
        }
      }
      setSelectedPaths(newSelected);
    }
  }, [folders, step, store]);

  // ── Freeze/unfreeze sort on phase transitions ──

  useEffect(() => {
    if (step === 3) store.freezeSort();
    if (step === 4) store.unfreezeSort();
  }, [step, store]);

  // ── Step transitions ──

  /** Step 1 -> 2: User selected a folder. Start scanning and advance. */
  const handleFolderSelected = useCallback(
    async (path: string, exclusions?: FolderExclusions) => {
      store.clear();
      setFolderPath(path);
      setStep(2);
      await startScan(path, false, exclusions);
    },
    [setFolderPath, setStep, startScan, store],
  );

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
      store.setFilter("all");
      store.setSearch("");

      setStep(3);
      await uploadJob.startUpload(pendingSelectedPaths, skipDuplicates);
    },
    [pendingSelectedPaths, setStep, uploadJob, store],
  );

  /** Step 3 -> 4: Upload finished, advance to completion. */
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

  const allFiles = useMemo(() => Array.from(store.getAllRows().values()), [files]);

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

  const selectFirstN = useCallback((n: number) => {
    const paths = files.slice(0, n).map((f) => f.path);
    setSelectedPaths(new Set(paths));
  }, [files]);

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

  const handleFilterClick = useCallback((filter: StatusFilter) => {
    store.setFilter(filter);
  }, [store]);

  // ── CSV download ──

  const handleDownloadCsv = useCallback(() => {
    const jobId = completedJob?.job_id ?? "unknown";
    downloadUploadCsv(Array.from(store.getAllRows().values()), jobId);
  }, [completedJob, store]);

  // ── Active totals for header ──

  const activeTotals = scanComplete ? totals : scanTotals;

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
          {phase === "review" ? (
            <ReviewToolbar
              statusFilter={store.getFilter()}
              onStatusFilterChange={(f) => store.setFilter(f)}
              searchQuery={store.getSearch()}
              onSearchChange={(q) => store.setSearch(q)}
              selectedCount={selectedPaths.size}
              totalCount={store.getSize()}
              filteredCount={files.length}
              showFilteredCount={store.getFilter() !== "all" || store.getSearch() !== ""}
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
          {phase === "review" && (
            <UploadFooter
              phase="review"
              onBack={handleBack}
              onStartUpload={handleStartUploadClick}
              selectedNewCount={selectedNewCount}
            />
          )}

          {/* The unified file table — stays mounted across phases */}
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

          {/* Bottom action buttons */}
          <UploadFooter
            phase={phase}
            onBack={handleBack}
            onStartUpload={handleStartUploadClick}
            selectedNewCount={selectedNewCount}
            onCancel={uploadJob.cancelUpload}
            isRunning={uploadJob.isRunning}
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
        </div>
      )}
    </div>
  );
}
