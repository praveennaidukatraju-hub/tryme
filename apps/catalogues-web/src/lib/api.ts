import {
  ApiError,
  httpStatusMessage,
  networkError,
  readResponseBody,
  responseError,
} from './errors';

export function getApiUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  if (typeof window === 'undefined') return envUrl;
  if (envUrl.includes('localhost') && window.location.hostname !== 'localhost') {
    return envUrl.replace('localhost', window.location.hostname);
  }
  return envUrl;
}

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// Access token lives only in module memory — never in a JS-readable cookie.
// XSS cannot steal it and forge long-lived sessions. On page reload the token
// is gone; the first 401 triggers tryRefresh() which re-hydrates it from the
// httpOnly refresh cookie without any user-visible interruption.
let _memToken: string | null = null;

/** Call after a successful login/register to seed the in-memory token. */
export function initToken(token: string): void {
  _memToken = token;
}

const AUTH_CHANNEL =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tryme-auth') : null;

AUTH_CHANNEL?.addEventListener('message', (e) => {
  if (e.data?.type === 'token-refreshed' && e.data?.accessToken) {
    _memToken = e.data.accessToken;
  }
});

export function getToken(): string | null {
  return _memToken;
}

// Single-flight: coalesce concurrent refreshes into one request. Without this,
// a page firing several requests at once all 401 together and each calls
// /refresh with the same (single-use) refresh token — the first rotates it,
// the rest hit a revoked token and force a logout. Dedup avoids that race.
let refreshInFlight: Promise<string | null> | null = null;

// Exported so other independent fetch clients (e.g. the SSE connection in
// sse.ts) share this single flight instead of racing their own refresh call
// against this one — see the comment above.
export function tryRefresh(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${BASE}/api/auth/refresh`, { method: 'POST' });
        if (!res.ok) return null;
        const data = (await res.json()) as { accessToken: string };
        _memToken = data.accessToken;
        AUTH_CHANNEL?.postMessage({ type: 'token-refreshed', accessToken: data.accessToken });
        return data.accessToken;
      } catch {
        return null;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function fetchApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    throw networkError(err);
  }
}

async function readApiResponse<T>(res: Response): Promise<T> {
  if (!res.ok) throw await responseError(res);
  return (await readResponseBody(res)) as T;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (options.body != null && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) headers.Authorization = `Bearer ${token}`;

  let res = await fetchApi(`${getApiUrl()}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      headers.Authorization = `Bearer ${refreshed}`;
      res = await fetchApi(`${getApiUrl()}${path}`, {
        ...options,
        headers,
        credentials: 'include',
      });
    } else {
      // Refresh failed — another tab may have already rotated the token and
      // broadcast it. Check the in-memory store one more time before giving up.
      const fallback = _memToken;
      if (fallback) {
        headers.Authorization = `Bearer ${fallback}`;
        res = await fetchApi(`${getApiUrl()}${path}`, {
          ...options,
          headers,
          credentials: 'include',
        });
      } else {
        if (typeof window !== 'undefined') window.location.href = `${BASE}/login`;
        throw new ApiError(401, {
          error: { code: 'SESSION_EXPIRED', message: 'Your session has expired. Sign in again.' },
        });
      }
    }
  }

  return readApiResponse<T>(res);
}

export const api = {
  get: <T>(path: string, options?: RequestInit) => request<T>(path, options),
  post: <T>(path: string, body: unknown, options?: RequestInit) =>
    request<T>(path, { ...options, method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  uploadToR2: async (uploadUrl: string, file: File): Promise<void> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error(httpStatusMessage(xhr.status)));
      xhr.onerror = () =>
        reject(new Error('Unable to upload the file. Check your connection and try again.'));
      xhr.send(file);
    });
  },
  uploadToR2WithProgress: (
    uploadUrl: string,
    file: File,
    onProgress: (pct: number) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error(httpStatusMessage(xhr.status)));
      xhr.onerror = () =>
        reject(new Error('Unable to upload the file. Check your connection and try again.'));
      xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
      if (signal) {
        if (signal.aborted) {
          xhr.abort();
          return;
        }
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(file);
    });
  },
};
