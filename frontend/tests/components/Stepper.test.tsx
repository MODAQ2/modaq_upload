/**
 * Tests for the Stepper component.
 */

import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";

import Stepper from "../../src/components/upload/Stepper.tsx";

afterEach(() => {
  cleanup();
});

describe("Stepper", () => {
  it("renders all four steps", () => {
    render(<Stepper currentStep={1} />);

    expect(screen.getByTestId("step-1")).toBeInTheDocument();
    expect(screen.getByTestId("step-2")).toBeInTheDocument();
    expect(screen.getByTestId("step-3")).toBeInTheDocument();
    expect(screen.getByTestId("step-4")).toBeInTheDocument();
  });

  it("displays step labels", () => {
    render(<Stepper currentStep={1} />);

    expect(screen.getByText("Select")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("Upload")).toBeInTheDocument();
    expect(screen.getByText("Complete")).toBeInTheDocument();
  });

  it("marks the current step as active", () => {
    render(<Stepper currentStep={2} />);

    const step2 = screen.getByTestId("step-2");
    expect(step2).toHaveAttribute("aria-current", "step");
  });

  it("shows checkmark icon for completed steps", () => {
    render(<Stepper currentStep={3} />);

    // Steps 1 and 2 should have checkmarks
    const checkmarks = screen.getAllByTestId("checkmark-icon");
    expect(checkmarks).toHaveLength(2);
  });

  it("shows numbers for active and future steps", () => {
    render(<Stepper currentStep={2} />);

    // Step 2 (active) should show "2"
    expect(screen.getByTestId("step-2")).toHaveTextContent("2");
    // Step 3 (future) should show "3"
    expect(screen.getByTestId("step-3")).toHaveTextContent("3");
    // Step 4 (future) should show "4"
    expect(screen.getByTestId("step-4")).toHaveTextContent("4");
  });

  it("allows clicking completed steps 1 and 2 when not uploading", async () => {
    const user = userEvent.setup();
    const onStepClick = vi.fn();

    render(
      <Stepper currentStep={3} onStepClick={onStepClick} isUploading={false} />,
    );

    // Step 1 (completed) should be clickable
    await user.click(screen.getByTestId("step-1"));
    expect(onStepClick).toHaveBeenCalledWith(1);

    // Step 2 (completed) should be clickable
    await user.click(screen.getByTestId("step-2"));
    expect(onStepClick).toHaveBeenCalledWith(2);
  });

  it("disables clicking completed steps when uploading", async () => {
    const user = userEvent.setup();
    const onStepClick = vi.fn();

    render(
      <Stepper currentStep={3} onStepClick={onStepClick} isUploading={true} />,
    );

    // Step 1 should be disabled
    const step1 = screen.getByTestId("step-1");
    expect(step1).toBeDisabled();

    await user.click(step1);
    expect(onStepClick).not.toHaveBeenCalled();
  });

  it("does not allow clicking future steps", async () => {
    const user = userEvent.setup();
    const onStepClick = vi.fn();

    render(
      <Stepper currentStep={1} onStepClick={onStepClick} />,
    );

    // Step 3 (future) should be disabled
    const step3 = screen.getByTestId("step-3");
    expect(step3).toBeDisabled();

    await user.click(step3);
    expect(onStepClick).not.toHaveBeenCalled();
  });

  it("does not allow clicking the active step", async () => {
    const user = userEvent.setup();
    const onStepClick = vi.fn();

    render(
      <Stepper currentStep={2} onStepClick={onStepClick} />,
    );

    const step2 = screen.getByTestId("step-2");
    expect(step2).toBeDisabled();

    await user.click(step2);
    expect(onStepClick).not.toHaveBeenCalled();
  });

  it("step 4 renders at correct position", () => {
    render(<Stepper currentStep={4} />);

    // All four previous steps should have checkmarks
    const checkmarks = screen.getAllByTestId("checkmark-icon");
    expect(checkmarks).toHaveLength(3); // Steps 1, 2, 3

    // Step 4 is active
    const step4 = screen.getByTestId("step-4");
    expect(step4).toHaveAttribute("aria-current", "step");
  });
});
