/**
 * Generic hook that wires up SSE streaming and cancel for any job workflow.
 *
 * Both ``useUploadJob`` and ``useDeleteJob`` delegate SSE subscription and
 * the cancel request to this hook, keeping workflow-specific message handling
 * in each caller.
 *
 * Usage:
 * ```ts
 * const { isCancelling, cancel } = useJobProgress({
 *   sseUrl:     jobId && isRunning ? `/api/upload/progress/${jobId}` : null,
 *   cancelUrl:  jobId ? `/api/upload/cancel/${jobId}` : null,
 *   onMessage:  handleMessage,
 *   onForceClose: () => { setIsRunning(false); setJobId(null); },
 * });
 * ```
 */

import { useCallback, useState } from 'react';

import { apiPost } from '../api/client.ts';
import { useSSE } from './useSSE.ts';

export interface UseJobProgressOptions {
  /** SSE stream URL; pass null when the job is not active. */
  sseUrl: string | null;
  /** Cancel endpoint URL; pass null when there is nothing to cancel. */
  cancelUrl: string | null;
  /** Invoked for every SSE message — caller handles event type dispatch. */
  onMessage: (data: unknown) => void;
  /**
   * Called when the SSE connection drops unexpectedly or the cancel POST
   * fails. Use this to force-reset any ``isRunning`` / ``jobId`` state.
   */
  onForceClose?: () => void;
}

export interface UseJobProgressResult {
  /** True while a cancel request is in-flight. */
  isCancelling: boolean;
  /** POST to the cancel URL and set ``isCancelling``. */
  cancel: () => Promise<void>;
}

export function useJobProgress({
  sseUrl,
  cancelUrl,
  onMessage,
  onForceClose,
}: UseJobProgressOptions): UseJobProgressResult {
  const [isCancelling, setIsCancelling] = useState(false);

  useSSE({
    url: sseUrl,
    onMessage,
    onError: () => {
      setIsCancelling(false);
      onForceClose?.();
    },
  });

  const cancel = useCallback(async () => {
    if (!cancelUrl) return;
    setIsCancelling(true);
    try {
      await apiPost(cancelUrl);
      // Terminal SSE event will arrive shortly and the caller's onMessage
      // handler is responsible for clearing isRunning / jobId.
    } catch {
      // Cancel POST failed — force-close so the UI doesn't hang.
      setIsCancelling(false);
      onForceClose?.();
    }
  }, [cancelUrl, onForceClose]);

  return { isCancelling, cancel };
}
