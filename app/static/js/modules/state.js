/**
 * Centralized mutable state for the modaq_upload.
 * Replaces all global `let` variables and `window.*` properties.
 */
const state = {
  /** @type {string | null} */
  currentJobId: null,

  /** @type {EventSource | null} */
  eventSource: null,

  /** @type {string | null} */
  selectedFolderPath: null,

  /** Current upload step (1-4) */
  currentStep: 1,

  /** S3 file browser current prefix */
  currentPrefix: '',

  /** @type {{ version?: string, commit?: string, branch?: string } | null} */
  appVersionData: null,

  /** @type {string | undefined} */
  currentAwsProfile: undefined,

  /** @type {string[]} */
  scanFilePaths: [],

  /** @type {Array<{ path: string, filename: string, size: number, mtime?: number, already_uploaded: boolean }>} */
  scanFileStatuses: [],

  /** Total size of all scanned files in bytes */
  scanTotalSize: 0,

  /** @type {string | null} */
  scanFolderPath: null,

  /** Sort configuration for the review table */
  reviewSortConfig: { column: 'filename', ascending: true },

  /** @type {Array<{ name: string, size: number, mtime: number }>} */
  browserFiles: [],

  /** Sort configuration for the folder browser file table */
  browserFileSortConfig: { column: 'name', ascending: true },

  /** Log viewer filter state */
  logFilters: {
    /** @type {string | null} */ date: null,
    /** @type {string | null} */ level: null,
    /** @type {string | null} */ category: null,
    /** @type {string} */ search: '',
  },

  /** Log viewer pagination state */
  logPagination: { offset: 0, limit: 100 },
};

export default state;
