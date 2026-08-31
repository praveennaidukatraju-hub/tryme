import { z } from 'zod';

export const GoogleDriveStatusResponse = z.object({
  status: z.enum(['NOT_CONNECTED', 'CONNECTED', 'REAUTH_REQUIRED']),
  googleEmail: z.string().nullable(),
});
export type GoogleDriveStatusResponse = z.infer<typeof GoogleDriveStatusResponse>;

export const GoogleDriveExportResponse = z.object({
  driveFileId: z.string(),
  webViewLink: z.string().url(),
});
export type GoogleDriveExportResponse = z.infer<typeof GoogleDriveExportResponse>;
