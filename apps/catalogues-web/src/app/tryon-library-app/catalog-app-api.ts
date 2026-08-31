import { getApiUrl } from '@/lib/api';
import { ApiError, networkError, readResponseBody, responseError } from '@/lib/errors';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// Kept in module memory only, isolated from lib/api.ts's own in-memory token —
// this route's session must not read/write the main site's session state.
let _memToken: string | null = null;

export function initCatalogAppToken(token: string): void {
  _memToken = token;
}

export function getCatalogAppToken(): string | null {
  return _memToken;
}

export function clearCatalogAppToken(): void {
  _memToken = null;
}

let refreshInFlight: Promise<string | null> | null = null;

function tryRefresh(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${BASE}/api/catalog-app/refresh`, { method: 'POST' });
        if (!res.ok) return null;
        const data = (await res.json()) as { accessToken?: string };
        if (!data.accessToken) return null;
        _memToken = data.accessToken;
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

/** Thrown when a request 401s and the silent refresh also fails — the page should show its login form again. */
export class CatalogAppSessionExpiredError extends Error {
  constructor() {
    super('Your session has expired. Sign in again.');
    this.name = 'CatalogAppSessionExpiredError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getCatalogAppToken();
  const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };
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
      clearCatalogAppToken();
      throw new CatalogAppSessionExpiredError();
    }
  }

  return readApiResponse<T>(res);
}

export const catalogAppApi = {
  get: <T>(path: string, options?: RequestInit) => request<T>(path, options),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
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
          : reject(new Error(`Upload failed (${xhr.status})`));
      xhr.onerror = () =>
        reject(new Error('Unable to upload the file. Check your connection and try again.'));
      xhr.send(file);
    });
  },
};

export async function catalogAppLogin(identifier: string, password: string): Promise<void> {
  const res = await fetch(`${BASE}/api/catalog-app/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: identifier, password }),
  });
  const body = await readResponseBody(res);
  if (!res.ok) throw new ApiError(res.status, body);
  const typed = body as { accessToken?: string };
  if (typed.accessToken) initCatalogAppToken(typed.accessToken);
}

export async function catalogAppLogout(): Promise<void> {
  await fetch(`${BASE}/api/catalog-app/logout`, { method: 'POST' }).catch(() => {});
  clearCatalogAppToken();
}
