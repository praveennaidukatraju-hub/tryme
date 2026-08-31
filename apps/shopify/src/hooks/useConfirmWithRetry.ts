import { useCallback, useState } from 'react';
import { ApiError } from '../lib/api';
import { type ClassifiedError, classifyError } from '../lib/errors';

// Shared by BillingCallbackPage and AutorefillCallbackPage: both land here
// straight off a Shopify-hosted redirect, where the charge/enrolment decision
// has already been made at Shopify's end — a swallowed error here means the
// merchant thinks it went through when it may not have. A blip on this one
// round-trip is plausible and worth absorbing quietly before bothering them.
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 1200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ConfirmResult<T> = { ok: true; data: T } | { ok: false };

export function useConfirmWithRetry<T>(confirmFn: () => Promise<T>) {
  const [error, setError] = useState<ClassifiedError | null>(null);

  const run = useCallback(async (): Promise<ConfirmResult<T>> => {
    setError(null);
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const data = await confirmFn();
        return { ok: true, data };
      } catch (err) {
        // Already being handled elsewhere: apiFetch navigates the top-level
        // frame into the reauth flow, which re-provisions the store and
        // returns here. Rendering an error would only race that redirect,
        // and retrying here cannot succeed until it completes.
        if (err instanceof ApiError && err.code === 'SHOPIFY_REAUTH_REQUIRED') {
          return { ok: false };
        }
        if (attempt === ATTEMPTS) {
          setError(classifyError(err));
          return { ok: false };
        }
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
    return { ok: false };
  }, [confirmFn]);

  return { error, run };
}
