import { SpinnerIcon } from "../../utils/icons";

interface SpinnerProps {
  message?: string;
  size?: "sm" | "md" | "lg";
}

const sizeMap = {
  sm: 20,
  md: 32,
  lg: 48,
};

export default function Spinner({ message, size = "md" }: SpinnerProps) {
  return (
    <div className="flex flex-col items-center gap-3">
      <SpinnerIcon
        className="animate-spin text-nlr-blue"
        size={sizeMap[size]}
        data-testid="spinner"
      />
      {message && <p className="text-sm text-gray-500">{message}</p>}
    </div>
  );
}
