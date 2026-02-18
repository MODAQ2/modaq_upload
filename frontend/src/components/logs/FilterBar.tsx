import { useCallback, useEffect, useState } from "react";
import { useDebounce } from "../../hooks/useDebounce.ts";

export interface LogFilters {
  date: string;
  level: string;
  category: string;
  search: string;
}

const EMPTY_FILTERS: LogFilters = {
  date: "",
  level: "",
  category: "",
  search: "",
};

const LEVELS = ["All", "INFO", "WARNING", "ERROR"] as const;
const CATEGORIES = ["All", "upload", "analysis", "settings", "app", "sync"] as const;

interface FilterBarProps {
  onFilterChange: (filters: LogFilters) => void;
}

export default function FilterBar({ onFilterChange }: FilterBarProps) {
  const [filters, setFilters] = useState<LogFilters>(EMPTY_FILTERS);
  const debouncedSearch = useDebounce(filters.search, 300);

  // Notify parent when any filter changes (debounced for search)
  const { date, level, category } = filters;
  useEffect(() => {
    onFilterChange({ date, level, category, search: debouncedSearch });
  }, [date, level, category, debouncedSearch, onFilterChange]);

  const updateFilter = useCallback(<K extends keyof LogFilters>(key: K, value: LogFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
  };

  const hasActiveFilters =
    filters.date !== "" || filters.level !== "" || filters.category !== "" || filters.search !== "";

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
      <div className="flex flex-wrap items-end gap-4">
        {/* Date picker */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 uppercase" htmlFor="log-date">
            Date
          </label>
          <input
            id="log-date"
            type="date"
            value={filters.date}
            onChange={(e) => updateFilter("date", e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-nlr-blue focus:border-transparent"
          />
        </div>

        {/* Level dropdown */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 uppercase" htmlFor="log-level">
            Level
          </label>
          <select
            id="log-level"
            value={filters.level}
            onChange={(e) => updateFilter("level", e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-nlr-blue focus:border-transparent bg-white"
          >
            {LEVELS.map((level) => (
              <option key={level} value={level === "All" ? "" : level}>
                {level}
              </option>
            ))}
          </select>
        </div>

        {/* Category dropdown */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 uppercase" htmlFor="log-category">
            Category
          </label>
          <select
            id="log-category"
            value={filters.category}
            onChange={(e) => updateFilter("category", e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-nlr-blue focus:border-transparent bg-white"
          >
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat === "All" ? "" : cat}>
                {cat}
              </option>
            ))}
          </select>
        </div>

        {/* Search input */}
        <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <label className="text-xs font-medium text-gray-500 uppercase" htmlFor="log-search">
            Search
          </label>
          <input
            id="log-search"
            type="text"
            value={filters.search}
            onChange={(e) => updateFilter("search", e.target.value)}
            placeholder="Search messages..."
            className="px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-nlr-blue focus:border-transparent"
          />
        </div>

        {/* Clear button */}
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
          >
            Clear Filters
          </button>
        )}
      </div>
    </div>
  );
}
