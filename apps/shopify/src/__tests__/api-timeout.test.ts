import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/appBridge', () => ({
  getIdToken: vi.fn().mockResolvedValue('session-token'),
}));

import { apiFetch } from '../lib/api';

function delayedJsonResponse(delayMs: number, body: unknown): typeof fetch {
  return vi.fn((_input: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(
          new Response(JSON.stringify(body), {
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }, delayMs);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  }) as typeof fetch;
}

describe('API request timeouts', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps the short timeout for ordinary API requests', async () => {
    vi.stubGlobal('fetch', delayedJsonResponse(13_000, { ok: true }));

    const request = apiFetch('/v1/shopify/me');
    const rejection = expect(request).rejects.toThrow(
      'Request timed out — check your connection and try again.',
    );
    await vi.advanceTimersByTimeAsync(12_000);

    await rejection;
  });

  it('tags a timeout with a synthetic .code so it can be classified', async () => {
    vi.stubGlobal('fetch', delayedJsonResponse(13_000, { ok: true }));

    const request = apiFetch('/v1/shopify/me');
    const assertion = request.catch((err) => {
      expect((err as { code?: string }).code).toBe('TIMEOUT');
    });
    await vi.advanceTimersByTimeAsync(12_000);

    await assertion;
  });
});
