/**
 * Icon exports using lucide-react.
 * Centralized icon library for consistent styling across the app.
 */

import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Cloud,
  Download,
  ExternalLink,
  File,
  Filter,
  Folder,
  Info,
  Loader2,
  Lock,
  type LucideProps,
  Minus,
  MoreVertical,
  Plus,
  Power,
  RefreshCw,
  Search,
  Settings,
  Shield,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';

// Re-export with consistent names
export const FileIcon = File;
export const FolderIcon = Folder;
export const CheckIcon = Check;
export const ChevronRightIcon = ChevronRight;
export const XIcon = X;
export const WarningIcon = AlertTriangle;
export const ErrorIcon = AlertCircle;
export const InfoIcon = Info;
export const SuccessIcon = CheckCircle;
export const ChevronUpIcon = ChevronUp;
export const ChevronDownIcon = ChevronDown;
export const ShieldIcon = Shield;
export const UploadIcon = Upload;
export const DownloadIcon = Download;
export const SearchIcon = Search;
export const FilterIcon = Filter;
export const MoreIcon = MoreVertical;
export const TrashIcon = Trash2;
export const SettingsIcon = Settings;
export const RefreshIcon = RefreshCw;
export const XCircleIcon = XCircle;
export const SpinnerIcon = Loader2;
export const ExternalLinkIcon = ExternalLink;
export const PlusIcon = Plus;
export const MinusIcon = Minus;
export const CloudIcon = Cloud;
export const CircleIcon = Circle;
export const LockIcon = Lock;
export const PowerIcon = Power;

// Export type for icon props
export type { LucideProps as IconProps };
