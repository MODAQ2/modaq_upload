/**
 * Global browser error reporting.
 *
 * Captures uncaught errors and unhandled promise rejections and ships them to
 * the backend (`POST /api/logs/client`), where they join the same JSONL log
 * pipeline and S3 sync as server-side errors.
 */

interface ClientLogPayload {
  level?: 'INFO' | 'WARNING' | 'ERROR';
  event?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

let installed = false;

/** Best-effort POST; never throws and never reports its own failures. */
function report(payload: ClientLogPayload): void {
  try {
    void fetch('/api/logs/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true, // survive page unload / navigation
    }).catch(() => {
      /* swallow: reporting must never cascade into more errors */
    });
  } catch {
    /* swallow */
  }
}

function baseMetadata(): Record<string, unknown> {
  return {
    url: window.location.href,
    user_agent: navigator.userAgent,
  };
}

/** Install global `error` and `unhandledrejection` listeners. Idempotent. */
export function installGlobalErrorReporting(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (e: ErrorEvent) => {
    report({
      level: 'ERROR',
      event: 'uncaught_error',
      message: e.message || 'Uncaught error',
      metadata: {
        ...baseMetadata(),
        source: e.filename,
        line: e.lineno,
        column: e.colno,
        stack: e.error instanceof Error ? e.error.stack : undefined,
      },
    });
  });

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'Unhandled promise rejection';
    report({
      level: 'ERROR',
      event: 'unhandled_rejection',
      message,
      metadata: {
        ...baseMetadata(),
        stack: reason instanceof Error ? reason.stack : undefined,
      },
    });
  });
}

/** Manually report a client-side error (e.g. from a React error boundary). */
export function reportClientError(message: string, metadata?: Record<string, unknown>): void {
  report({
    level: 'ERROR',
    event: 'client_error',
    message,
    metadata: { ...baseMetadata(), ...metadata },
  });
}

/**
 * Report a non-error client-side event (e.g. a request-timing measurement) at
 * INFO level. Lands in the same JSONL log pipeline + S3 sync as backend logs.
 */
export function reportClientEvent(
  event: string,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  report({
    level: 'INFO',
    event,
    message,
    metadata: { ...baseMetadata(), ...metadata },
  });
}
