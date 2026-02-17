import { useEffect, useRef } from "react";
import { ChevronRightIcon } from "../../utils/icons.tsx";

interface BreadcrumbItem {
  label: string;
  onClick?: () => void;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

export default function Breadcrumb({ items }: BreadcrumbProps) {
  const scrollRef = useRef<HTMLElement>(null);

  // Auto-scroll to the end so the current folder is always visible
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollLeft = el.scrollWidth;
    }
  }, [items]);

  return (
    <nav
      ref={scrollRef}
      className="flex items-center text-sm text-gray-500 overflow-x-auto whitespace-nowrap scrollbar-hide"
      aria-label="Breadcrumb"
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span key={index} className="flex items-center flex-shrink-0">
            {index > 0 && <ChevronRightIcon className="w-4 h-4 mx-1 text-gray-400" />}
            {isLast || !item.onClick ? (
              <span className={isLast ? "text-gray-900 font-medium" : ""}>{item.label}</span>
            ) : (
              <button
                onClick={item.onClick}
                className="hover:text-nlr-blue hover:underline"
              >
                {item.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
