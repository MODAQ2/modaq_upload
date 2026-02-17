/**
 * Generic hook for consuming Server-Sent Events (SSE) from a finite stream.
 *
 * Creates an EventSource when `url` is non-null; closes on cleanup or when
 * the stream ends. No auto-reconnect — our SSE streams are finite.
 */

import { useEffect, useRef } from "react";

export interface UseSSEOptions {
  /** URL to connect to. Pass `null` to stay disconnected. */
  url: string | null;
  /** Called for every `data:` line (already JSON-parsed). */
  onMessage: (data: unknown) => void;
  /** Called on EventSource errors. */
  onError?: (error: Event) => void;
}

export function useSSE({ url, onMessage, onError }: UseSSEOptions): void {
  // Store latest callbacks in refs so we never re-open a connection just
  // because the caller created a new closure.
  const onMessageRef = useRef(onMessage);
  const onErrorRef = useRef(onError);
  onMessageRef.current = onMessage;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!url) return;

    const es = new EventSource(url);

    es.onmessage = (event: MessageEvent) => {
      try {
        const data: unknown = JSON.parse(event.data as string);
        onMessageRef.current(data);
      } catch {
        // Ignore non-JSON messages (e.g., keep-alive pings)
      }
    };

    es.onerror = (event: Event) => {
      onErrorRef.current?.(event);
      // The server closes the stream on terminal events, which fires an error
      // event with readyState CLOSED. We just close our side too.
      es.close();
    };

    return () => {
      es.close();
    };
  }, [url]);
}
