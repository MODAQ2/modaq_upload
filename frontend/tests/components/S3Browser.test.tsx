import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import S3Browser from "../../src/components/files/S3Browser.tsx";

// Mock the API client
vi.mock("../../src/api/client.ts", () => ({
  apiGet: vi.fn(),
}));

import { apiGet } from "../../src/api/client.ts";

const mockApiGet = vi.mocked(apiGet);

const MOCK_LIST_RESPONSE = {
  success: true,
  folders: [
    { name: "year=2024", prefix: "year=2024/" },
    { name: "year=2025", prefix: "year=2025/" },
  ],
  files: [
    { name: "test.mcap", key: "test.mcap", size: 1024, last_modified: "2024-01-15T10:30:00Z" },
  ],
  breadcrumbs: [],
};

const MOCK_SUBFOLDER_RESPONSE = {
  success: true,
  folders: [
    { name: "month=01", prefix: "year=2024/month=01/" },
    { name: "month=02", prefix: "year=2024/month=02/" },
  ],
  files: [],
  breadcrumbs: [{ name: "year=2024", prefix: "year=2024/" }],
};

describe("S3Browser", () => {
  beforeEach(() => {
    mockApiGet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows loading spinner initially", () => {
    mockApiGet.mockReturnValue(new Promise(() => {})); // Never resolves
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);
    expect(screen.getByText("Loading files...")).toBeInTheDocument();
  });

  it("renders bucket name and region", async () => {
    mockApiGet.mockResolvedValue(MOCK_LIST_RESPONSE);
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getAllByText("my-bucket").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText("(us-west-2)")).toBeInTheDocument();
  });

  it("renders folders and files from the API response", async () => {
    mockApiGet.mockResolvedValue(MOCK_LIST_RESPONSE);
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getByText("year=2024")).toBeInTheDocument();
    });
    expect(screen.getByText("year=2025")).toBeInTheDocument();
    expect(screen.getByText("test.mcap")).toBeInTheDocument();
    expect(screen.getByText("1.0 KB")).toBeInTheDocument();
  });

  it("navigates into a folder when clicked", async () => {
    const user = userEvent.setup();
    mockApiGet
      .mockResolvedValueOnce(MOCK_LIST_RESPONSE) // Initial load
      .mockResolvedValueOnce(MOCK_SUBFOLDER_RESPONSE); // After click

    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getByText("year=2024")).toBeInTheDocument();
    });

    await user.click(screen.getByText("year=2024"));

    await waitFor(() => {
      expect(screen.getByText("month=01")).toBeInTheDocument();
    });
    expect(screen.getByText("month=02")).toBeInTheDocument();
  });

  it("shows an error message and retry button on API failure", async () => {
    mockApiGet.mockRejectedValue(new Error("Network error"));
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("shows empty state when no files or folders", async () => {
    mockApiGet.mockResolvedValue({
      success: true,
      folders: [],
      files: [],
      breadcrumbs: [],
    });
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getByText("No files or folders found at this location.")).toBeInTheDocument();
    });
  });
});
