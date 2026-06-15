import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import S3FolderPicker from '../../src/components/common/S3FolderPicker.tsx';
import {
  resolveDestination,
  sanitizeFolderName,
} from '../../src/components/common/s3FolderPath.ts';

vi.mock('../../src/api/client.ts', () => ({
  apiGet: vi.fn(),
}));

import { apiGet } from '../../src/api/client.ts';

const mockApiGet = vi.mocked(apiGet);

const ROOT_RESPONSE = {
  success: true,
  folders: [
    { name: 'deployment_a', prefix: 'deployment_a/' },
    { name: 'raw', prefix: 'raw/' },
  ],
  files: [],
  breadcrumbs: [],
};

const SUBFOLDER_RESPONSE = {
  success: true,
  folders: [{ name: 'logs', prefix: 'raw/logs/' }],
  files: [],
  breadcrumbs: [{ name: 'raw', prefix: 'raw/' }],
};

describe('resolveDestination', () => {
  it('returns the current prefix (no trailing slash) for existing mode', () => {
    expect(resolveDestination('raw/logs/', 'existing', '')).toBe('raw/logs');
  });

  it('returns empty at the bucket root in existing mode (root is not a folder)', () => {
    expect(resolveDestination('', 'existing', 'ignored')).toBe('');
  });

  it('concatenates a new subfolder name onto the current prefix', () => {
    expect(resolveDestination('raw/', 'new', 'run_1')).toBe('raw/run_1');
  });

  it('creates a top-level folder when at the root in new mode', () => {
    expect(resolveDestination('', 'new', 'run_1')).toBe('run_1');
  });

  it('returns empty when the new name is blank', () => {
    expect(resolveDestination('raw/', 'new', '   ')).toBe('');
  });
});

describe('sanitizeFolderName', () => {
  it('trims and strips surrounding slashes', () => {
    expect(sanitizeFolderName('  /my folder/ ')).toBe('my folder');
  });

  it('collapses internal whitespace', () => {
    expect(sanitizeFolderName('a   b')).toBe('a b');
  });
});

describe('S3FolderPicker', () => {
  beforeEach(() => mockApiGet.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('lists folders and reports an empty destination at the root', async () => {
    mockApiGet.mockResolvedValue(ROOT_RESPONSE);
    const onSelect = vi.fn();
    render(<S3FolderPicker bucket="my-bucket" onSelect={onSelect} />);

    await waitFor(() => expect(screen.getByText('deployment_a')).toBeInTheDocument());
    expect(screen.getByText('raw')).toBeInTheDocument();
    // At the root with an empty new-name field, the destination is invalid ('').
    expect(onSelect).toHaveBeenLastCalledWith('');
  });

  it('resolves a destination when a new subfolder name is typed', async () => {
    mockApiGet.mockResolvedValue(ROOT_RESPONSE);
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<S3FolderPicker bucket="my-bucket" onSelect={onSelect} />);

    await waitFor(() => expect(screen.getByText('raw')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('new-folder-name'), 'run_1');

    await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith('run_1'));
  });

  it('lets the user navigate into a folder and sync into it', async () => {
    mockApiGet.mockResolvedValueOnce(ROOT_RESPONSE).mockResolvedValueOnce(SUBFOLDER_RESPONSE);
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<S3FolderPicker bucket="my-bucket" onSelect={onSelect} />);

    await waitFor(() => expect(screen.getByText('raw')).toBeInTheDocument());
    await user.click(screen.getByText('raw'));

    await waitFor(() => expect(screen.getByText('logs')).toBeInTheDocument());
    // "Sync into this folder" is now enabled (not at root) — select it.
    await user.click(screen.getByLabelText(/sync into this folder/i, { exact: false }));

    await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith('raw'));
  });

  it('applies the suggested timestamp name via the shortcut button', async () => {
    mockApiGet.mockResolvedValue(ROOT_RESPONSE);
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <S3FolderPicker bucket="my-bucket" onSelect={onSelect} suggestedName="user_upload_2025" />,
    );

    await waitFor(() => expect(screen.getByText('raw')).toBeInTheDocument());
    await user.click(screen.getByText('Use timestamp default'));

    await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith('user_upload_2025'));
  });
});
