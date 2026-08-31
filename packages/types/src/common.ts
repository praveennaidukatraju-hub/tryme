import { z } from 'zod';
export const Paginated = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const ErrorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
