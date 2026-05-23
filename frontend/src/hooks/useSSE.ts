/**
 * Generic hook for consuming Server-Sent Events (SSE) from a finite stream.
 *
 * Creates an EventSource when `url` is non-null; closes on cleanup or when
 * the stream ends. No auto-reconnect — our SSE streams are finite.
 *
 * Features:
 * - Automatic timeout detection (60s without messages triggers error)
 * - Heartbeat support (server sends ": heartbeat" comments to keep alive)
 * - Clean error handling and connection cleanup
 */

import { useEffect, useRef } from 'react';

export interface UseSSEOptions {
  /** URL to connect to. Pass `null` to stay disconnected. */
  url: string | null;
  /** Called for every `data:` line (already JSON-parsed). */
  onMessage: (data: unknown) => void;
  /** Called on EventSource errors or timeout. */
  onError?: (error: Event) => void;
  /** Timeout in milliseconds (default: 60000 = 60s). Set to 0 to disable. */
  timeout?: number;
}

export function useSSE({ url, onMessage, onError, timeout = 60000 }: UseSSEOptions): void {
  // Store latest callbacks in refs so we never re-open a connection just
  // because the caller created a new closure.
  const onMessageRef = useRef(onMessage);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onMessageRef.current = onMessage;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (!url) return;

    const es = new EventSource(url);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    // Start timeout timer if enabled
    const resetTimeout = () => {
      if (timeout > 0) {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          // No messages received for timeout duration — connection likely dead
          const timeoutError = new Event('timeout');
          onErrorRef.current?.(timeoutError);
          es.close();
        }, timeout);
      }
    };

    resetTimeout(); // Initial timeout

    es.onmessage = (event: MessageEvent) => {
      // Reset timeout on any message (including heartbeats)
      resetTimeout();

      try {
        const data: unknown = JSON.parse(event.data as string);
        onMessageRef.current(data);
      } catch {
        // Ignore non-JSON messages (e.g., ": heartbeat" comment lines)
        // These still reset the timeout above, which is their purpose
      }
    };

    es.onerror = (event: Event) => {
      if (timeoutId) clearTimeout(timeoutId);
      onErrorRef.current?.(event);
      // The server closes the stream on terminal events, which fires an error
      // event with readyState CLOSED. We just close our side too.
      es.close();
    };

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      es.close();
    };
  }, [url, timeout]);
}
