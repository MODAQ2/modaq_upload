/**
 * Reusable alert banner for displaying information, warnings, errors, and success messages.
 */

import { InfoIcon, WarningIcon, ErrorIcon, SuccessIcon, ShieldIcon } from "../../utils/icons.tsx";
import type { ReactNode } from "react";

type AlertType = "info" | "warning" | "error" | "success" | "shield";

interface AlertBannerProps {
  type: AlertType;
  title?: string;
  message: ReactNode;
  icon?: ReactNode;
  className?: string;
}

const alertStyles: Record<AlertType, string> = {
  info: "bg-blue-50 border-blue-200",
  warning: "bg-yellow-50 border-yellow-200",
  error: "bg-red-50 border-red-200",
  success: "bg-green-50 border-green-200",
  shield: "bg-green-50 border-green-200",
};

const titleStyles: Record<AlertType, string> = {
  info: "text-blue-800",
  warning: "text-yellow-800",
  error: "text-red-800",
  success: "text-green-800",
  shield: "text-green-800",
};

const messageStyles: Record<AlertType, string> = {
  info: "text-blue-700",
  warning: "text-yellow-700",
  error: "text-red-700",
  success: "text-green-700",
  shield: "text-green-700",
};

const iconMap: Record<AlertType, typeof InfoIcon> = {
  info: InfoIcon,
  warning: WarningIcon,
  error: ErrorIcon,
  success: SuccessIcon,
  shield: ShieldIcon,
};

const iconColorStyles: Record<AlertType, string> = {
  info: "text-blue-500",
  warning: "text-yellow-500",
  error: "text-red-500",
  success: "text-green-500",
  shield: "text-green-500",
};

export default function AlertBanner({
  type,
  title,
  message,
  icon,
  className = "",
}: AlertBannerProps) {
  const Icon = iconMap[type];

  return (
    <div className={`border rounded-lg p-4 ${alertStyles[type]} ${className}`}>
      <div className="flex items-start gap-3">
        {icon || <Icon className={`w-6 h-6 mt-0.5 shrink-0 ${iconColorStyles[type]}`} />}
        <div className="flex-1">
          {title && <h3 className={`text-sm font-semibold ${titleStyles[type]}`}>{title}</h3>}
          <div className={`text-sm ${messageStyles[type]} ${title ? "mt-1" : ""}`}>{message}</div>
        </div>
      </div>
    </div>
  );
}
