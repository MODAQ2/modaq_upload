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

  /** Current upload step (1-5) */
  currentStep: 1,

  /** S3 file browser current prefix */
  currentPrefix: "",

  /** @type {{ version?: string, commit?: string, branch?: string } | null} */
  appVersionData: null,

  /** @type {string | undefined} */
  currentAwsProfile: undefined,

  /** @type {string[]} */
  scanFilePaths: [],

  /** @type {Array<{ path: string, filename: string, size: number, already_uploaded: boolean }>} */
  scanFileStatuses: [],
};

export default state;
