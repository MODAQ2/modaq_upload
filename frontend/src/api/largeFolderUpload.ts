/** API helpers for the Large Folder Upload feature. */

import { apiPost } from './client.ts';

export interface StartSyncResponse {
  job_id: string;
  s3_uri: string;
  cmd: string;
}

export async function startLargeFolderSync(
  folderPath: string,
  s3Prefix: string,
): Promise<StartSyncResponse> {
  return apiPost<StartSyncResponse>('/api/large-folder-upload/start', {
    folder_path: folderPath,
    s3_prefix: s3Prefix,
  });
}

export async function cancelLargeFolderSync(jobId: string): Promise<void> {
  await apiPost(`/api/large-folder-upload/cancel/${jobId}`);
}
