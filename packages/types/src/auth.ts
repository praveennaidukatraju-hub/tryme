import { z } from 'zod';
export const RegisterBody = z.object({
  email: z.string().email().max(254),
  password: z
    .string()
    .min(8)
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  displayName: z.string().min(1).max(80),
  // ?src= query param from the signup link, e.g. a QR-code campaign code.
  // Resolved against signup_campaigns server-side; an unknown/expired code is
  // silently ignored, never a validation error.
  signupSource: z.string().max(64).optional(),
});
// Field is still named `email` on the wire for backward compatibility with
// existing clients (web, the saree catalogue Android app) that already POST
// `{ email, password }` -- but the value may now be an email OR a username
// (admin-created accounts, see CreateUserBody). Do not rename this field.
export const LoginBody = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(128),
});
// Used only by POST /v1/auth/login (the main web login route) — NOT by
// LoginBody itself, so DeviceLoginBody (which extends LoginBody for the
// Android app) is unaffected.
export const WebLoginBody = LoginBody.extend({
  portal: z.enum(['catalog-app']).optional(),
});
export const TokenPair = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
