import { beforeEach, describe, expect, it } from 'vitest';

import {
  defaultPrefix,
  useLargeFolderUploadStore,
} from '../../src/stores/largeFolderUploadStore.ts';

describe('largeFolderUploadStore', () => {
  beforeEach(() => {
    useLargeFolderUploadStore.getState().reset();
  });

  it('starts with an empty s3Prefix (no auto timestamp)', () => {
    expect(useLargeFolderUploadStore.getState().s3Prefix).toBe('');
  });

  it('reset() clears s3Prefix back to empty', () => {
    useLargeFolderUploadStore.getState().setS3Prefix('some/existing/folder');
    expect(useLargeFolderUploadStore.getState().s3Prefix).toBe('some/existing/folder');

    useLargeFolderUploadStore.getState().reset();
    expect(useLargeFolderUploadStore.getState().s3Prefix).toBe('');
  });

  it('defaultPrefix() produces a user_upload_ timestamp name', () => {
    expect(defaultPrefix()).toMatch(/^user_upload_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });
});
