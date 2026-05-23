import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import SettingsForm from "../../src/components/settings/SettingsForm.tsx";
import { useAppStore } from "../../src/stores/appStore.ts";

// Mock the API client
vi.mock("../../src/api/client.ts", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));

// Import mocked functions for control
import { apiGet } from "../../src/api/client.ts";

const mockApiGet = vi.mocked(apiGet);

describe("SettingsForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up store with settings
    useAppStore.setState({
      settings: {
        aws_profile: "default",
        aws_region: "us-west-2",
        s3_bucket: "test-bucket",
        default_upload_folder: "/data/mcap",
        display_name: "Test App",
        log_directory: "logs",
      },
      settingsLoading: false,
    });

    // Mock profiles endpoint
    mockApiGet.mockResolvedValue({ profiles: ["default", "production"] });
  });

  it("renders all form fields", async () => {
    render(<SettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText("AWS Profile")).toBeInTheDocument();
    });

    expect(screen.getByLabelText("AWS Region")).toBeInTheDocument();
    expect(screen.getByLabelText("S3 Bucket")).toBeInTheDocument();
    expect(screen.getByLabelText("Default Upload Folder")).toBeInTheDocument();
    expect(screen.getByLabelText("Display Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Log Directory")).toBeInTheDocument();
  });

  it("shows Test Connection and Save Settings buttons", async () => {
    render(<SettingsForm />);

    await waitFor(() => {
      expect(screen.getByText("Test Connection")).toBeInTheDocument();
    });

    expect(screen.getByText("Save Settings")).toBeInTheDocument();
  });

  it("populates form fields from settings", async () => {
    render(<SettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText("S3 Bucket")).toHaveValue("test-bucket");
    });

    expect(screen.getByLabelText("Default Upload Folder")).toHaveValue("/data/mcap");
    expect(screen.getByLabelText("Display Name")).toHaveValue("Test App");
    expect(screen.getByLabelText("Log Directory")).toHaveValue("logs");
  });

  it("fetches profiles on mount", async () => {
    render(<SettingsForm />);

    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith("/api/settings/profiles");
    });
  });
});
