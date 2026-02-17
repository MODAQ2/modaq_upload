/**
 * Unified step progress indicator for multi-step workflows.
 *
 * - Green circle + checkmark = completed step
 * - Blue circle + number = active step
 * - Gray circle + number = future step
 * - Completed steps are clickable (go back) when not in active operation.
 */

import { CheckIcon } from "../../utils/icons.tsx";

interface StepDef {
  number: number;
  label: string;
}

interface StepperProps {
  steps: StepDef[];
  currentStep: number;
  onStepClick?: (step: number) => void;
  /** When true, disables clicking back to earlier steps. */
  isOperating?: boolean;
  /** Maximum step number that can be clicked back to (default: 2) */
  maxClickableStep?: number;
  /** ARIA label for the navigation element */
  ariaLabel?: string;
  /** Test ID prefix for step buttons */
  testIdPrefix?: string;
}

export default function Stepper({
  steps,
  currentStep,
  onStepClick,
  isOperating = false,
  maxClickableStep = 2,
  ariaLabel = "Progress steps",
  testIdPrefix = "step",
}: StepperProps) {
  return (
    <nav className="flex items-center justify-center mb-8" aria-label={ariaLabel}>
      {steps.map((step, index) => {
        const isDone = step.number < currentStep;
        const isActive = step.number === currentStep;
        const isFuture = step.number > currentStep;

        // Only allow clicking completed steps up to maxClickableStep while not operating.
        const canClick =
          isDone && !isOperating && step.number <= maxClickableStep && !!onStepClick;

        function handleClick() {
          if (canClick) onStepClick(step.number);
        }

        // Circle styling
        let circleClass =
          "w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-colors";
        if (isDone) {
          circleClass += " bg-green-500 text-white";
          if (canClick) circleClass += " cursor-pointer hover:bg-green-600";
        } else if (isActive) {
          circleClass += " bg-nlr-blue text-white";
        } else {
          circleClass += " bg-gray-300 text-gray-500";
        }

        // Connector line between steps
        const showConnector = index < steps.length - 1;

        return (
          <div key={step.number} className="flex items-center">
            <div className="flex flex-col items-center">
              <button
                type="button"
                className={circleClass}
                onClick={handleClick}
                disabled={!canClick}
                aria-current={isActive ? "step" : undefined}
                aria-label={`Step ${step.number}: ${step.label}${isDone ? " (completed)" : ""}${isActive ? " (current)" : ""}`}
                data-testid={`${testIdPrefix}-${step.number}`}
              >
                {isDone ? <CheckIcon className="w-5 h-5" /> : step.number}
              </button>
              <span
                className={`mt-1.5 text-xs font-medium ${
                  isDone
                    ? "text-green-600"
                    : isActive
                      ? "text-nlr-blue"
                      : "text-gray-400"
                }${isFuture ? "" : ""}`}
              >
                {step.label}
              </span>
            </div>
            {showConnector && (
              <div
                className={`w-16 sm:w-24 h-0.5 mx-2 mb-5 ${
                  step.number < currentStep ? "bg-green-500" : "bg-gray-300"
                }`}
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}
