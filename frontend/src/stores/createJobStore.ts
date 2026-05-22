/**
 * Factory for Zustand stores that follow the stepped-job-workflow pattern.
 *
 * Both the upload and delete workflows share identical state for:
 *   - step navigation (``step`` / ``setStep``)
 *   - folder selection (``folderPath`` / ``setFolderPath``)
 *   - full reset (``reset``)
 *
 * ``createJobStore`` generates these fields automatically. Callers provide
 * workflow-specific extra state via ``initialExtra`` and ``extraSlice``.
 *
 * Usage:
 * ```ts
 * export const useUploadStore = createJobStore(
 *   1 as UploadStep,
 *   { uploadJobId: null, completedJob: null } as UploadExtra,
 *   (set) => ({
 *     setUploadJobId: (id) => set({ uploadJobId: id }),
 *     setCompletedJob: (job) => set({ completedJob: job }),
 *   }),
 * );
 * ```
 */

import { create } from 'zustand';

/** The state slice produced automatically by ``createJobStore``. */
export interface BaseJobState<TStep extends number> {
  step: TStep;
  setStep: (step: TStep) => void;

  folderPath: string;
  setFolderPath: (path: string) => void;

  reset: () => void;
}

type FullState<TStep extends number, TExtra extends object> = BaseJobState<TStep> & TExtra;

// Zustand's set function signature (partial or functional update, no replace needed)
type SetFn<T> = (partial: Partial<T> | ((state: T) => Partial<T>)) => void;

/**
 * Create a Zustand store that includes the common job-workflow base slice
 * plus any workflow-specific extra state.
 *
 * @param initialStep   The step value on first render and after reset.
 * @param initialExtra  Initial values for workflow-specific fields.
 * @param extraSlice    Function that receives Zustand's ``set`` and returns
 *                      the workflow-specific actions (setters, etc.).
 */
export function createJobStore<TStep extends number, TExtra extends object>(
  initialStep: TStep,
  initialExtra: TExtra,
  extraSlice: (set: SetFn<FullState<TStep, TExtra>>) => TExtra,
) {
  const initialBase = {
    step: initialStep,
    folderPath: '',
  };
  const initialState = { ...initialBase, ...initialExtra };

  // Strip setter functions so reset() only restores data fields — never
  // overwrites the real setters with the no-op placeholders in initialExtra.
  const initialData = Object.fromEntries(
    Object.entries(initialState).filter(([, v]) => typeof v !== 'function'),
  ) as Partial<FullState<TStep, TExtra>>;

  return create<FullState<TStep, TExtra>>((set) => ({
    ...initialState,

    setStep: (step) => set({ step } as Partial<FullState<TStep, TExtra>>),
    setFolderPath: (folderPath) => set({ folderPath } as Partial<FullState<TStep, TExtra>>),
    reset: () => set(initialData),

    ...extraSlice(set),
  }));
}
