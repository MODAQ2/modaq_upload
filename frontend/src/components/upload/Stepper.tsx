/**
 * 4-step progress indicator for the upload workflow.
 * Wrapper around the unified Stepper component.
 */

import Stepper from "../common/Stepper.tsx";
import type { UploadStep } from "../../stores/uploadStore.ts";

const steps = [
  { number: 1, label: "Select" },
  { number: 2, label: "Review" },
  { number: 3, label: "Upload" },
  { number: 4, label: "Complete" },
];

interface UploadStepperProps {
  currentStep: UploadStep;
  onStepClick?: (step: UploadStep) => void;
  /** When true, disables clicking back to earlier steps. */
  isUploading?: boolean;
}

export default function UploadStepper({
  currentStep,
  onStepClick,
  isUploading = false,
}: UploadStepperProps) {
  return (
    <Stepper
      steps={steps}
      currentStep={currentStep}
      onStepClick={onStepClick as ((step: number) => void) | undefined}
      isOperating={isUploading}
      maxClickableStep={2}
      ariaLabel="Upload steps"
      testIdPrefix="step"
    />
  );
}
