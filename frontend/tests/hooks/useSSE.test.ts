/**
 * Tests for the useSSE hook.
 */

import { renderHook, act, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { useSSE } from "../../src/hooks/useSSE.ts";

// Mock EventSource
class MockEventSource {
  url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  // Simulate a message from the server
  simulateMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent("message", { data: JSON.stringify(data) }));
    }
  }

  // Simulate an error
  simulateError() {
    if (this.onerror) {
      this.onerror(new Event("error"));
    }
  }

  static instances: MockEventSource[] = [];
  static clear() {
    MockEventSource.instances = [];
  }
}

// Install mock
beforeEach(() => {
  MockEventSource.clear();
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useSSE", () => {
  it("does not create an EventSource when url is null", () => {
    const onMessage = vi.fn();
    renderHook(() => useSSE({ url: null, onMessage }));

    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("creates an EventSource when url is provided", () => {
    const onMessage = vi.fn();
    renderHook(() =>
      useSSE({ url: "/api/upload/progress/test-id", onMessage }),
    );

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]!.url).toBe(
      "/api/upload/progress/test-id",
    );
  });

  it("calls onMessage with parsed JSON data", () => {
    const onMessage = vi.fn();
    renderHook(() =>
      useSSE({ url: "/api/upload/progress/test-id", onMessage }),
    );

    const es = MockEventSource.instances[0]!;
    act(() => {
      es.simulateMessage({ type: "scan_started", folders_total: 5 });
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({
      type: "scan_started",
      folders_total: 5,
    });
  });

  it("ignores non-JSON messages without throwing", () => {
    const onMessage = vi.fn();
    renderHook(() =>
      useSSE({ url: "/api/upload/progress/test-id", onMessage }),
    );

    const es = MockEventSource.instances[0]!;
    // Send raw non-JSON string
    act(() => {
      if (es.onmessage) {
        es.onmessage(new MessageEvent("message", { data: "not-json" }));
      }
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("calls onError and closes on error", () => {
    const onMessage = vi.fn();
    const onError = vi.fn();
    renderHook(() =>
      useSSE({ url: "/api/upload/progress/test-id", onMessage, onError }),
    );

    const es = MockEventSource.instances[0]!;
    act(() => {
      es.simulateError();
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(es.closed).toBe(true);
  });

  it("closes the EventSource on unmount", () => {
    const onMessage = vi.fn();
    const { unmount } = renderHook(() =>
      useSSE({ url: "/api/upload/progress/test-id", onMessage }),
    );

    const es = MockEventSource.instances[0]!;
    expect(es.closed).toBe(false);

    unmount();

    expect(es.closed).toBe(true);
  });

  it("closes old EventSource and opens new one when url changes", () => {
    const onMessage = vi.fn();
    const { rerender } = renderHook(
      ({ url }: { url: string | null }) => useSSE({ url, onMessage }),
      { initialProps: { url: "/api/upload/progress/id-1" } },
    );

    expect(MockEventSource.instances).toHaveLength(1);
    const first = MockEventSource.instances[0]!;

    rerender({ url: "/api/upload/progress/id-2" });

    expect(first.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]!.url).toBe(
      "/api/upload/progress/id-2",
    );
  });

  it("closes EventSource when url changes to null", () => {
    const onMessage = vi.fn();
    const { rerender } = renderHook(
      ({ url }: { url: string | null }) => useSSE({ url, onMessage }),
      { initialProps: { url: "/api/upload/progress/id-1" as string | null } },
    );

    const es = MockEventSource.instances[0]!;
    expect(es.closed).toBe(false);

    rerender({ url: null });

    expect(es.closed).toBe(true);
  });
});
