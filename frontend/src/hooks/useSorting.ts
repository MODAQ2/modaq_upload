import { useCallback, useMemo, useState } from "react";

export interface UseSortingResult<T extends string> {
  sortColumn: T;
  ascending: boolean;
  toggleSort: (column: T) => void;
  sortFn: <R extends Record<string, unknown>>(a: R, b: R) => number;
}

export function useSorting<T extends string>(
  defaultColumn: T,
  defaultAscending = true,
): UseSortingResult<T> {
  const [sortColumn, setSortColumn] = useState<T>(defaultColumn);
  const [ascending, setAscending] = useState(defaultAscending);

  const toggleSort = useCallback(
    (column: T) => {
      if (column === sortColumn) {
        setAscending((prev) => !prev);
      } else {
        setSortColumn(column);
        setAscending(true);
      }
    },
    [sortColumn],
  );

  const sortFn = useMemo(() => {
    return <R extends Record<string, unknown>>(a: R, b: R): number => {
      const aVal = a[sortColumn];
      const bVal = b[sortColumn];

      let comparison = 0;
      if (typeof aVal === "string" && typeof bVal === "string") {
        comparison = aVal.localeCompare(bVal);
      } else if (typeof aVal === "number" && typeof bVal === "number") {
        comparison = aVal - bVal;
      } else {
        comparison = String(aVal ?? "").localeCompare(String(bVal ?? ""));
      }

      return ascending ? comparison : -comparison;
    };
  }, [sortColumn, ascending]);

  return { sortColumn, ascending, toggleSort, sortFn };
}
