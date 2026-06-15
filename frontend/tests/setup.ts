import '@testing-library/jest-dom/vitest';

// Ensure consistent timezone across all test environments
process.env.TZ = 'UTC';

// jsdom lacks ResizeObserver, which @tanstack/react-virtual uses to learn the
// scroll element's size. A no-op never reports a size, so the virtualizer keeps a
// 0-height viewport and renders nothing. This stub calls back once on observe with
// a non-zero box so virtualized lists render their rows in tests.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(el: Element) {
      this.cb(
        [
          {
            target: el,
            contentRect: el.getBoundingClientRect(),
            borderBoxSize: [{ inlineSize: 800, blockSize: 600 }],
            contentBoxSize: [{ inlineSize: 800, blockSize: 600 }],
            devicePixelContentBoxSize: [{ inlineSize: 800, blockSize: 600 }],
          } as unknown as ResizeObserverEntry,
        ],
        this,
      );
    }
    unobserve() {}
    disconnect() {}
  };
}

// jsdom reports zero geometry for every element, which makes @tanstack/react-virtual
// measure a 0-height viewport and render no rows. Give elements a non-zero rect so
// virtualized lists render their items in tests.
if (!('__rectStubbed' in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, '__rectStubbed', { value: true });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect;
  };
}
