import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import S3Browser from '../../src/components/files/S3Browser.tsx';

// Mock the API client
vi.mock('../../src/api/client.ts', () => ({
  apiGet: vi.fn(),
}));

// Mock the client-side logger so timing reports don't fire real network calls.
vi.mock('../../src/utils/errorReporter.ts', () => ({
  reportClientEvent: vi.fn(),
}));

import { apiGet } from '../../src/api/client.ts';
import { reportClientEvent } from '../../src/utils/errorReporter.ts';

const mockApiGet = vi.mocked(apiGet);
const mockReportClientEvent = vi.mocked(reportClientEvent);

const STATS_RESPONSE = {
  success: true,
  prefix: '',
  folder_count: 2,
  file_count: 1,
};

// Route apiGet by URL so the /api/files/stats call doesn't consume the queued
// /api/files/list responses. `listResponses` are returned in order per list call.
function mockApi(listResponses: unknown[], stats: unknown = STATS_RESPONSE) {
  let listCall = 0;
  mockApiGet.mockImplementation((url: string) => {
    if (url === '/api/files/stats') return Promise.resolve(stats);
    const idx = Math.min(listCall, listResponses.length - 1);
    listCall += 1;
    return Promise.resolve(listResponses[idx]);
  });
}

const MOCK_LIST_RESPONSE = {
  success: true,
  folders: [
    { name: 'year=2024', prefix: 'year=2024/' },
    { name: 'year=2025', prefix: 'year=2025/' },
  ],
  files: [
    { name: 'test.mcap', key: 'test.mcap', size: 1024, last_modified: '2024-01-15T10:30:00Z' },
  ],
  breadcrumbs: [],
};

const MOCK_SUBFOLDER_RESPONSE = {
  success: true,
  folders: [
    { name: 'month=01', prefix: 'year=2024/month=01/' },
    { name: 'month=02', prefix: 'year=2024/month=02/' },
  ],
  files: [],
  breadcrumbs: [{ name: 'year=2024', prefix: 'year=2024/' }],
};

describe('S3Browser', () => {
  beforeEach(() => {
    mockApiGet.mockReset();
    mockReportClientEvent.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a thin loading bar (not a full spinner) while fetching', () => {
    mockApiGet.mockReturnValue(new Promise(() => {})); // Never resolves
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);
    // The list fetch shows the indeterminate top bar, and never the old
    // full-panel "Loading files..." spinner.
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByText('Loading files...')).not.toBeInTheDocument();
  });

  it('clears the previous folder while navigating, then shows the new one', async () => {
    const user = userEvent.setup();
    let resolveSecond: ((v: unknown) => void) | undefined;
    let listCall = 0;
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/files/stats') return Promise.resolve(STATS_RESPONSE);
      listCall += 1;
      if (listCall === 1) return Promise.resolve(MOCK_LIST_RESPONSE);
      // Second navigation: keep it pending so we can observe the loading state.
      return new Promise((resolve) => {
        resolveSecond = resolve;
      });
    });

    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getByText('year=2024')).toBeInTheDocument();
    });

    await user.click(screen.getByText('year=2024'));

    // The previous folder's rows are cleared immediately so the parent's
    // contents don't linger under the new breadcrumb. The loading bar shows.
    expect(screen.queryByText('test.mcap')).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    resolveSecond?.(MOCK_SUBFOLDER_RESPONSE);
    await waitFor(() => {
      expect(screen.getByText('month=01')).toBeInTheDocument();
    });
  });

  it('renders bucket name and region', async () => {
    mockApi([MOCK_LIST_RESPONSE]);
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getAllByText('my-bucket').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText('(us-west-2)')).toBeInTheDocument();
  });

  it('renders folders and files from the API response', async () => {
    mockApi([MOCK_LIST_RESPONSE]);
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getByText('year=2024')).toBeInTheDocument();
    });
    expect(screen.getByText('year=2025')).toBeInTheDocument();
    expect(screen.getByText('test.mcap')).toBeInTheDocument();
    expect(screen.getByText('1.0 KB')).toBeInTheDocument();
  });

  it('navigates into a folder when clicked', async () => {
    const user = userEvent.setup();
    mockApi([MOCK_LIST_RESPONSE, MOCK_SUBFOLDER_RESPONSE]);

    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getByText('year=2024')).toBeInTheDocument();
    });

    await user.click(screen.getByText('year=2024'));

    await waitFor(() => {
      expect(screen.getByText('month=01')).toBeInTheDocument();
    });
    expect(screen.getByText('month=02')).toBeInTheDocument();
  });

  it('shows an error message and retry button on API failure', async () => {
    mockApiGet.mockRejectedValue(new Error('Network error'));
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('shows a Load more button and appends the next page when clicked', async () => {
    const user = userEvent.setup();
    mockApi([
      {
        success: true,
        folders: [],
        files: [
          { name: 'a.mcap', key: 'a.mcap', size: 1024, last_modified: '2024-01-15T10:30:00Z' },
        ],
        breadcrumbs: [],
        next_token: 'TOKEN_PAGE_2',
      },
      {
        success: true,
        folders: [],
        files: [
          { name: 'b.mcap', key: 'b.mcap', size: 2048, last_modified: '2024-01-16T10:30:00Z' },
        ],
        breadcrumbs: [],
        next_token: null,
      },
    ]);

    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getByText('a.mcap')).toBeInTheDocument();
    });
    expect(screen.getByText('Load more')).toBeInTheDocument();

    await user.click(screen.getByText('Load more'));

    // Both pages are now visible and the button is gone (no more pages).
    await waitFor(() => {
      expect(screen.getByText('b.mcap')).toBeInTheDocument();
    });
    expect(screen.getByText('a.mcap')).toBeInTheDocument();
    expect(screen.queryByText('Load more')).not.toBeInTheDocument();

    // The second call passed the continuation token.
    expect(mockApiGet).toHaveBeenLastCalledWith(
      '/api/files/list',
      expect.objectContaining({ token: 'TOKEN_PAGE_2' }),
    );
  });

  it('does not show Load more when there are no further pages', async () => {
    mockApi([MOCK_LIST_RESPONSE]);
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getByText('test.mcap')).toBeInTheDocument();
    });
    expect(screen.queryByText('Load more')).not.toBeInTheDocument();
  });

  it('shows a note summarizing the folder contents', async () => {
    mockApi([MOCK_LIST_RESPONSE], {
      success: true,
      prefix: '',
      folder_count: 2,
      file_count: 1240,
    });
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(
        screen.getByText('This folder contains 2 subfolders and 1,240 files.'),
      ).toBeInTheDocument();
    });
  });

  it('singularizes the note for a single file and folder', async () => {
    mockApi([MOCK_LIST_RESPONSE], {
      success: true,
      prefix: '',
      folder_count: 1,
      file_count: 1,
    });
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getByText('This folder contains 1 subfolder and 1 file.')).toBeInTheDocument();
    });
  });

  it('shows an "over N items" note when counting was capped', async () => {
    mockApi([MOCK_LIST_RESPONSE], {
      success: true,
      prefix: '',
      folder_count: 2000,
      file_count: 0,
      capped: true,
    });
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getByText('Large folder — over 2,000 items.')).toBeInTheDocument();
    });
  });

  it('reports list and stats request timings to the client logger', async () => {
    mockApi([MOCK_LIST_RESPONSE]);
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getByText('test.mcap')).toBeInTheDocument();
    });

    await waitFor(() => {
      const events = mockReportClientEvent.mock.calls.map((c) => c[0]);
      expect(events).toContain('s3_list_timing');
      expect(events).toContain('s3_stats_timing');
    });

    const listCall = mockReportClientEvent.mock.calls.find((c) => c[0] === 's3_list_timing');
    expect(listCall?.[2]).toMatchObject({
      endpoint: '/api/files/list',
      duration_ms: expect.any(Number),
    });
  });

  it('shows empty state when no files or folders', async () => {
    mockApi([
      {
        success: true,
        folders: [],
        files: [],
        breadcrumbs: [],
      },
    ]);
    render(<S3Browser bucketName="my-bucket" region="us-west-2" />);

    await waitFor(() => {
      expect(screen.getByText('No files or folders found at this location.')).toBeInTheDocument();
    });
  });
});
