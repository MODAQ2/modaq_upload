import { useAppStore, type Notification as NotificationType } from "../../stores/appStore.ts";
import { SuccessIcon, ErrorIcon, InfoIcon, WarningIcon, XIcon } from "../../utils/icons.tsx";

const typeStyles: Record<NotificationType["type"], string> = {
  success: "bg-green-50 border-green-400 text-green-800",
  error: "bg-red-50 border-red-400 text-red-800",
  info: "bg-blue-50 border-blue-400 text-blue-800",
  warning: "bg-yellow-50 border-yellow-400 text-yellow-800",
};

const iconMap: Record<NotificationType["type"], typeof InfoIcon> = {
  success: SuccessIcon,
  error: ErrorIcon,
  info: InfoIcon,
  warning: WarningIcon,
};

export default function NotificationStack() {
  const notifications = useAppStore((s) => s.notifications);
  const removeNotification = useAppStore((s) => s.removeNotification);

  if (notifications.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 max-w-sm" data-testid="notification-stack">
      {notifications.map((n) => {
        const Icon = iconMap[n.type];
        return (
          <div
            key={n.id}
            className={`border-l-4 rounded-r-lg p-4 shadow-lg flex items-start gap-3 animate-[fadeIn_0.2s_ease-out] ${typeStyles[n.type]}`}
          >
            <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <span className="text-sm flex-grow">{n.message}</span>
            <button
              onClick={() => removeNotification(n.id)}
              className="flex-shrink-0 hover:opacity-70"
              aria-label="Dismiss notification"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
