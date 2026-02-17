/**
 * 5-step progress indicator for the delete workflow.
 * Wrapper around the unified Stepper component.
 */

import Stepper from "../common/Stepper.tsx";
import type { DeleteStep } from "../../stores/deleteStore.ts";

const steps = [
  { number: 1, label: "Select" },
  { number: 2, label: "Review" },
  { number: 3, label: "Confirm" },
  { number: 4, label: "Clear" },
  { number: 5, label: "Complete" },
];

interface DeleteStepperProps {
  currentStep: DeleteStep;
  onStepClick?: (step: DeleteStep) => void;
  isDeleting?: boolean;
}

export default function DeleteStepper({
  currentStep,
  onStepClick,
  isDeleting = false,
}: DeleteStepperProps) {
  return (
    <Stepper
      steps={steps}
      currentStep={currentStep}
      onStepClick={onStepClick as ((step: number) => void) | undefined}
      isOperating={isDeleting}
      maxClickableStep={2}
      ariaLabel="Delete steps"
      testIdPrefix="delete-step"
    />
  );
}
