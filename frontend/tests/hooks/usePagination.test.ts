import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePagination } from "../../src/hooks/usePagination.ts";

describe("usePagination", () => {
  it("starts at page 1 with default limit of 100", () => {
    const { result } = renderHook(() => usePagination());
    expect(result.current.currentPage).toBe(1);
    expect(result.current.limit).toBe(100);
    expect(result.current.offset).toBe(0);
    expect(result.current.totalPages).toBe(1);
  });

  it("respects custom page size", () => {
    const { result } = renderHook(() => usePagination(25));
    expect(result.current.limit).toBe(25);
  });

  it("computes totalPages when setTotal is called", () => {
    const { result } = renderHook(() => usePagination(50));
    act(() => {
      result.current.setTotal(120);
    });
    expect(result.current.totalPages).toBe(3); // ceil(120/50)
  });

  it("navigates with nextPage and prevPage", () => {
    const { result } = renderHook(() => usePagination(10));
    act(() => {
      result.current.setTotal(50);
    });
    expect(result.current.totalPages).toBe(5);

    act(() => {
      result.current.nextPage();
    });
    expect(result.current.currentPage).toBe(2);
    expect(result.current.offset).toBe(10);

    act(() => {
      result.current.nextPage();
    });
    expect(result.current.currentPage).toBe(3);
    expect(result.current.offset).toBe(20);

    act(() => {
      result.current.prevPage();
    });
    expect(result.current.currentPage).toBe(2);
    expect(result.current.offset).toBe(10);
  });

  it("does not go below page 1", () => {
    const { result } = renderHook(() => usePagination(10));
    act(() => {
      result.current.setTotal(30);
    });
    act(() => {
      result.current.prevPage();
    });
    expect(result.current.currentPage).toBe(1);
  });

  it("does not go above totalPages", () => {
    const { result } = renderHook(() => usePagination(10));
    act(() => {
      result.current.setTotal(20);
    });
    // totalPages = 2
    act(() => {
      result.current.goToPage(5);
    });
    expect(result.current.currentPage).toBe(2);
  });

  it("goToPage navigates to the correct page", () => {
    const { result } = renderHook(() => usePagination(10));
    act(() => {
      result.current.setTotal(100);
    });
    act(() => {
      result.current.goToPage(7);
    });
    expect(result.current.currentPage).toBe(7);
    expect(result.current.offset).toBe(60);
  });

  it("clamps current page when total shrinks", () => {
    const { result } = renderHook(() => usePagination(10));
    act(() => {
      result.current.setTotal(100);
    });
    act(() => {
      result.current.goToPage(10);
    });
    expect(result.current.currentPage).toBe(10);

    act(() => {
      result.current.setTotal(30);
    });
    // totalPages = 3, so page should clamp to 3
    expect(result.current.currentPage).toBe(3);
  });

  it("reset goes back to page 1", () => {
    const { result } = renderHook(() => usePagination(10));
    act(() => {
      result.current.setTotal(50);
    });
    act(() => {
      result.current.goToPage(4);
    });
    expect(result.current.currentPage).toBe(4);

    act(() => {
      result.current.reset();
    });
    expect(result.current.currentPage).toBe(1);
    expect(result.current.offset).toBe(0);
  });
});
