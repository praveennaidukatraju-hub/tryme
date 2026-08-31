import { z } from 'zod';

// Standard 15-char GSTIN: 2-digit state code, 10-char PAN (5 letters + 4
// digits + 1 letter), 1-digit entity code, literal 'Z', 1 checksum char.
// Format only — no checksum computation (product decision, see
// docs/superpowers/specs/2026-08-12-gst-invoice-for-credit-purchases-design.md).
export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export const Gstin = z
  .string()
  .regex(GSTIN_REGEX, 'Invalid GSTIN format')
  .optional()
  .or(z.literal(''));

export const CreditsResponse = z.object({
  balance: z.number().int().min(0),
  recent: z.array(
    z.object({
      id: z.string().uuid(),
      delta: z.number().int(),
      reason: z.string(),
      createdAt: z.string(),
    }),
  ),
});
