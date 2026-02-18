import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Modal from "../../src/components/common/Modal.tsx";
import ProgressBar from "../../src/components/common/ProgressBar.tsx";
import StatCard from "../../src/components/common/StatCard.tsx";
import Breadcrumb from "../../src/components/common/Breadcrumb.tsx";
import Spinner from "../../src/components/common/Spinner.tsx";
import SortableHeader from "../../src/components/common/SortableHeader.tsx";

describe("Modal", () => {
  it("renders nothing when isOpen is false", () => {
    render(
      <Modal isOpen={false} onClose={() => {}} title="Test">
        <p>body</p>
      </Modal>,
    );
    expect(screen.queryByText("Test")).not.toBeInTheDocument();
  });

  it("renders title, body, and footer when open", () => {
    render(
      <Modal isOpen={true} onClose={() => {}} title="My Modal" footer={<button>OK</button>}>
        <p>Hello world</p>
      </Modal>,
    );
    expect(screen.getByText("My Modal")).toBeInTheDocument();
    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
  });

  it("calls onClose when Escape is pressed", async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={handleClose} title="Test">
        <p>content</p>
      </Modal>,
    );

    await user.keyboard("{Escape}");
    expect(handleClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when backdrop is clicked", async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={handleClose} title="Test">
        <p>content</p>
      </Modal>,
    );

    await user.click(screen.getByTestId("modal-backdrop"));
    expect(handleClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose when modal content is clicked", async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={handleClose} title="Test">
        <p>content</p>
      </Modal>,
    );

    await user.click(screen.getByText("content"));
    expect(handleClose).not.toHaveBeenCalled();
  });

  it("calls onClose when close button (X) is clicked", async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={handleClose} title="Test">
        <p>content</p>
      </Modal>,
    );

    await user.click(screen.getByLabelText("Close modal"));
    expect(handleClose).toHaveBeenCalledOnce();
  });
});

describe("StatCard", () => {
  it("renders value and label", () => {
    render(<StatCard value={42} label="Total Files" />);
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("Total Files")).toBeInTheDocument();
  });

  it("renders string values", () => {
    render(<StatCard value="1.5 GB" label="Total Size" />);
    expect(screen.getByText("1.5 GB")).toBeInTheDocument();
    expect(screen.getByText("Total Size")).toBeInTheDocument();
  });

  it("applies default text color to value", () => {
    render(<StatCard value={0} label="Test" />);
    const value = screen.getByText("0");
    expect(value.className).toContain("text-nlr-blue");
  });

  it("applies custom text color to value", () => {
    render(<StatCard value={0} label="Test" color="text-red-500" />);
    const value = screen.getByText("0");
    expect(value.className).toContain("text-red-500");
  });
});

describe("ProgressBar", () => {
  it("shows correct width style", () => {
    render(<ProgressBar percent={65} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveStyle({ width: "65%" });
  });

  it("shows percentage text when label is provided", () => {
    render(<ProgressBar percent={42} label="Uploading" />);
    expect(screen.getByText("Uploading")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("clamps percent to 0-100 range", () => {
    render(<ProgressBar percent={150} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveStyle({ width: "100%" });
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
  });

  it("clamps negative percent to 0", () => {
    render(<ProgressBar percent={-10} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveStyle({ width: "0%" });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
  });

  it("applies default color", () => {
    render(<ProgressBar percent={50} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.className).toContain("bg-nlr-blue");
  });
});

describe("Breadcrumb", () => {
  it("renders all items", () => {
    render(
      <Breadcrumb
        items={[
          { label: "Home", onClick: () => {} },
          { label: "Files", onClick: () => {} },
          { label: "Current" },
        ]}
      />,
    );
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
  });

  it("makes the last item non-clickable", () => {
    render(
      <Breadcrumb
        items={[
          { label: "Home", onClick: () => {} },
          { label: "Current" },
        ]}
      />,
    );
    // Last item should be a span, not a button
    expect(screen.getByText("Current").tagName).toBe("SPAN");
    // First item should be a button
    expect(screen.getByText("Home").tagName).toBe("BUTTON");
  });

  it("calls onClick when a breadcrumb item is clicked", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(
      <Breadcrumb
        items={[
          { label: "Home", onClick: handleClick },
          { label: "Current" },
        ]}
      />,
    );

    await user.click(screen.getByText("Home"));
    expect(handleClick).toHaveBeenCalledOnce();
  });
});

describe("Spinner", () => {
  it("renders without a message", () => {
    render(<Spinner />);
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
  });

  it("renders with a message", () => {
    render(<Spinner message="Loading data..." />);
    expect(screen.getByText("Loading data...")).toBeInTheDocument();
  });
});

describe("SortableHeader", () => {
  it("renders label and calls onSort when clicked", async () => {
    const user = userEvent.setup();
    const handleSort = vi.fn();
    const { container } = render(
      <table>
        <thead>
          <tr>
            <SortableHeader label="Name" active={false} ascending={true} onSort={handleSort} />
          </tr>
        </thead>
      </table>,
    );
    expect(screen.getByText("Name")).toBeInTheDocument();

    const th = container.querySelector("th");
    expect(th).not.toBeNull();
    await user.click(th!);
    expect(handleSort).toHaveBeenCalledOnce();
  });
});
