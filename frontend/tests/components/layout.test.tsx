import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import Layout from "../../src/components/layout/Layout.tsx";
import NavBar from "../../src/components/layout/NavBar.tsx";
import { useAppStore } from "../../src/stores/appStore.ts";

// Mock react-router-dom's Outlet so Layout renders without child routes
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    Outlet: () => <div data-testid="outlet">page content</div>,
  };
});

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("Layout", () => {
  beforeEach(() => {
    useAppStore.setState({
      settings: null,
      version: { version: "1.2.3", commit: "abc1234def5678", branch: "main", dirty: false },
      notifications: [],
    });
  });

  it("renders Header, NavBar, Footer, and Outlet", () => {
    renderWithRouter(<Layout />);

    // Header - title defaults to MODAQ Upload when settings are null
    expect(screen.getByText("MODAQ Upload")).toBeInTheDocument();

    // NavBar links
    expect(screen.getByText("Upload")).toBeInTheDocument();
    expect(screen.getByText("Browse Uploaded Files")).toBeInTheDocument();
    expect(screen.getByText("History")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();

    // Footer
    expect(screen.getByText("National Laboratory of the Rockies")).toBeInTheDocument();

    // Outlet (mocked)
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
  });

  it("opens AboutModal when version badge is clicked", async () => {
    const user = userEvent.setup();
    renderWithRouter(<Layout />);

    const badge = screen.getByText("v1.2.3");
    await user.click(badge);

    // Modal should now be open - check for the modal backdrop and version info
    expect(screen.getByTestId("modal-backdrop")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "About" })).toBeInTheDocument();
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    expect(screen.getByText("abc1234")).toBeInTheDocument();
  });

  it("closes AboutModal when close button is clicked", async () => {
    const user = userEvent.setup();
    renderWithRouter(<Layout />);

    await user.click(screen.getByText("v1.2.3"));
    expect(screen.getByTestId("modal-backdrop")).toBeInTheDocument();

    // Click the footer Close button
    const closeButtons = screen.getAllByText("Close");
    await user.click(closeButtons[0]);
    expect(screen.queryByTestId("modal-backdrop")).not.toBeInTheDocument();
  });
});

describe("NavBar", () => {
  beforeEach(() => {
    useAppStore.setState({
      version: { version: "2.0.0", commit: "deadbeef", branch: "develop", dirty: false },
    });
  });

  it("shows all 4 nav links", () => {
    renderWithRouter(<NavBar onAboutClick={() => {}} />);

    expect(screen.getByText("Upload")).toBeInTheDocument();
    expect(screen.getByText("Browse Uploaded Files")).toBeInTheDocument();
    expect(screen.getByText("History")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("shows version badge and calls onAboutClick when clicked", async () => {
    const user = userEvent.setup();
    const handleAboutClick = vi.fn();
    renderWithRouter(<NavBar onAboutClick={handleAboutClick} />);

    const badge = screen.getByText("v2.0.0");
    expect(badge).toBeInTheDocument();

    await user.click(badge);
    expect(handleAboutClick).toHaveBeenCalledOnce();
  });

  it("hides version badge when version is not loaded", () => {
    useAppStore.setState({ version: null });
    renderWithRouter(<NavBar onAboutClick={() => {}} />);

    expect(screen.queryByText(/^v/)).not.toBeInTheDocument();
  });
});
