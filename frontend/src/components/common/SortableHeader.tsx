import { ChevronUpIcon, ChevronDownIcon } from "../../utils/icons.tsx";

interface SortableHeaderProps {
  label: string;
  active: boolean;
  ascending: boolean;
  onSort: () => void;
}

export default function SortableHeader({ label, active, ascending, onSort }: SortableHeaderProps) {
  return (
    <th
      className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none"
      onClick={onSort}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`inline-flex flex-col leading-none ${active ? "text-nlr-blue" : "text-gray-300"}`}>
          <ChevronUpIcon
            className={`w-3 h-3 ${active && ascending ? "text-nlr-blue" : ""}`}
          />
          <ChevronDownIcon
            className={`w-3 h-3 ${active && !ascending ? "text-nlr-blue" : ""}`}
          />
        </span>
      </span>
    </th>
  );
}
