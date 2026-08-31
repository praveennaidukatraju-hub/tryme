import { z } from 'zod';
import { AssetContentType } from './admin.js';

export const PresignMyBackgroundBody = z.object({
  contentType: AssetContentType,
  contentLength: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
});

export const ConfirmMyBackgroundBody = z.object({
  r2Key: z.string().min(1),
  label: z.string().min(1).max(120).optional(),
});

export const CreateMyBackgroundFromUrlBody = z.object({
  url: z.string().url(),
  label: z.string().min(1).max(120).optional(),
});
