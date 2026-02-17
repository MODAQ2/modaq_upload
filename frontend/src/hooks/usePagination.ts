import { useCallback, useMemo, useState } from "react";

export interface UsePaginationResult {
  offset: number;
  limit: number;
  currentPage: number;
  totalPages: number;
  setTotal: (total: number) => void;
  goToPage: (page: number) => void;
  nextPage: () => void;
  prevPage: () => void;
  reset: () => void;
}

export function usePagination(pageSize = 100): UsePaginationResult {
  const [currentPage, setCurrentPage] = useState(1);
  const [total, setTotalRaw] = useState(0);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / pageSize)),
    [total, pageSize],
  );

  const offset = (currentPage - 1) * pageSize;

  const setTotal = useCallback(
    (newTotal: number) => {
      setTotalRaw(newTotal);
      // Clamp current page if total shrinks
      const newTotalPages = Math.max(1, Math.ceil(newTotal / pageSize));
      setCurrentPage((prev) => Math.min(prev, newTotalPages));
    },
    [pageSize],
  );

  const goToPage = useCallback(
    (page: number) => {
      setCurrentPage(Math.max(1, Math.min(page, totalPages)));
    },
    [totalPages],
  );

  const nextPage = useCallback(() => {
    setCurrentPage((prev) => Math.min(prev + 1, totalPages));
  }, [totalPages]);

  const prevPage = useCallback(() => {
    setCurrentPage((prev) => Math.max(prev - 1, 1));
  }, []);

  const reset = useCallback(() => {
    setCurrentPage(1);
  }, []);

  return {
    offset,
    limit: pageSize,
    currentPage,
    totalPages,
    setTotal,
    goToPage,
    nextPage,
    prevPage,
    reset,
  };
}
