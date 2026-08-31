/**
 * Fetch-based SSE client for the admin SPA.
 * Mirrors apps/catalogues-web/src/lib/sse.ts but uses the admin auth token from data.ts.
 */

import { apiErrorFromResponse, getToken, setToken } from './data';

const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const BACKOFF_FACTOR = 2;
const RESET_DELAY_AFTER_MS = 10_000;

export interface SSEEvent<T = unknown> {
  type: string;
  data: T;
}

export interface SSEConnection {
  close(): void;
}

function parseSSEBlocks<T>(text: string, onEvent: (e: SSEEvent<T>) => void): void {
  for (const block of text.split('\n\n')) {
    let eventType = 'message';
    let dataLine = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
    }
    if (!dataLine) continue;
    try {
      onEvent({ type: eventType, data: JSON.parse(dataLine) as T });
    } catch {
      /* ignore malformed data */
    }
  }
}

async function tryRefreshAdminToken(): Promise<string | null> {
  try {
    const res = await fetch('/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!res.ok) return null;
    const { accessToken } = (await res.json()) as { accessToken: string };
    setToken(accessToken);
    return accessToken;
  } catch {
    return null;
  }
}

export function createSSEConnection<T = unknown>(
  path: string,
  onEvent: (e: SSEEvent<T>) => void,
  onAuthFailure?: () => void,
  onError?: (err: Error) => void,
): SSEConnection {
  let closed = false;
  let controller: AbortController | null = null;
  let retryDelay = INITIAL_DELAY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastDataAt = 0;

  async function connect(): Promise<void> {
    if (closed) return;
    controller = new AbortController();

    try {
      let token = getToken();
      const makeHeaders = (t: string | null): Record<string, string> =>
        t ? { Authorization: `Bearer ${t}` } : {};

      let res = await fetch(path, {
        headers: makeHeaders(token),
        credentials: 'include',
        signal: controller.signal,
      });

      if (res.status === 401) {
        token = await tryRefreshAdminToken();
        if (!token) {
          onAuthFailure?.();
          closed = true;
          return;
        }
        res = await fetch(path, {
          headers: makeHeaders(token),
          credentials: 'include',
          signal: controller.signal,
        });
      }

      if (!res.ok) throw await apiErrorFromResponse(res);
      if (!res.body) throw new Error('The live update connection returned no data.');

      if (Date.now() - lastDataAt < RESET_DELAY_AFTER_MS) retryDelay = INITIAL_DELAY_MS;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        lastDataAt = Date.now();
        retryDelay = INITIAL_DELAY_MS;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const block of parts) {
          parseSSEBlocks(`${block}\n\n`, onEvent);
        }
      }
    } catch (err) {
      if (closed) return;
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.name === 'AbortError') return;
      onError?.(error);
    }

    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (closed) return;
    retryTimer = setTimeout(() => {
      retryDelay = Math.min(retryDelay * BACKOFF_FACTOR, MAX_DELAY_MS);
      void connect();
    }, retryDelay);
  }

  void connect();

  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
    },
  };
}

export interface AdminSSEConnection {
  close: () => void;
}

export function createAdminSSEConnection(
  url: string,
  token: string,
  onEvent: (raw: string) => void,
  onReconnect?: () => void,
): AdminSSEConnection {
  let closed = false;
  let retryDelay = 2_000;

  async function connect() {
    if (closed) return;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      });
      if (!res.ok) throw await apiErrorFromResponse(res);
      if (!res.body) throw new Error('The live update connection returned no data.');
      retryDelay = 2_000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop() ?? '';
        for (const block of blocks) {
          const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
          if (dataLine) onEvent(dataLine.slice(5).trim());
        }
      }
    } catch {
      // fall through to reconnect
    }
    if (!closed) {
      onReconnect?.();
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    }
  }

  void connect();
  return {
    close: () => {
      closed = true;
    },
  };
}
