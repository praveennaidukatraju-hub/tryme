import type { Stats } from '../types';

export const TONES = [
  'oklch(0.86 0.04 60)',
  'oklch(0.72 0.08 35)',
  'oklch(0.58 0.06 30)',
  'oklch(0.40 0.02 270)',
  'oklch(0.82 0.03 90)',
  'oklch(0.68 0.08 110)',
];

export const STATUS_ORDER = [
  'PENDING_MANNEQUIN',
  'QUEUED',
  'PREPROCESSING',
  'GENERATING',
  'UPLOADING',
  'COMPLETED',
] as const;

export function statusBadge(s: string): [string, string] {
  const m: Record<string, [string, string]> = {
    PENDING_MANNEQUIN: ['info', 'Preparing garment'],
    QUEUED: ['info', 'Queued'],
    PREPROCESSING: ['accent', 'Preprocessing'],
    GENERATING: ['accent', 'Generating'],
    UPLOADING: ['accent', 'Uploading'],
    COMPLETED: ['success', 'Completed'],
    FAILED: ['danger', 'Failed'],
    CANCELLED: ['', 'Cancelled'],
    IDLE: ['', 'Idle'],
    BUSY: ['accent', 'Busy'],
    DRAINING: ['warn', 'Draining'],
    OFFLINE: ['danger', 'Offline'],
    active: ['success', 'Active'],
    inactive: ['', 'Inactive'],
    draft: ['', 'Draft'],
    archived: ['', 'Archived'],
  };
  return m[s] || ['', s];
}

export function jobTypeBadge(t: string): [string, string] {
  const m: Record<string, [string, string]> = {
    catalog: ['', 'Catalog'],
    catalog_video: ['success', 'Catalog Video'],
    tryon: ['info', 'Try On'],
    saree: ['accent', 'Saree'],
    saree_mannequin: ['warn', 'Saree Prep'],
    shopify: ['success', 'Shopify'],
    merchant_tryon: ['accent', 'Merchant Try-On'],
    kiosk: ['accent', 'Kiosk'],
    merchant_catalog: ['accent', 'Try On Library'],
    merchant_catalog_saree_mannequin: ['warn', 'Try On Library Prep'],
    api_tryon: ['success', 'API Try On'],
    api_saree_mannequin: ['success', 'API Saree Prep'],
    api_catalog: ['success', 'API Catalog'],
    api: ['success', 'API (legacy)'],
  };
  if (!m[t]) {
    console.warn(
      `jobTypeBadge: unrecognized job source "${t}" — add it to the label map in apps/admin-web/src/lib/data.ts`,
    );
  }
  return m[t] || ['', t];
}

export const MOCK_STATS: Stats = {
  jobsToday: 1247,
  jobsTodayDelta: 12.4,
  creditsToday: 6235,
  creditsTodayDelta: 8.1,
  activeUsersToday: 384,
  activeUsersDelta: -2.6,
  workersHealthy: 6,
  workersTotal: 8,
  queueDepth: 41,
  failed24h: 23,
  failed24hDelta: 156,
  jobsPerDay: [890, 1024, 1156, 982, 1340, 1421, 1247],
  jobsPerDayLabels: ['May 13', 'May 14', 'May 15', 'May 16', 'May 17', 'May 18', 'Today'],
};

// ── API client ──────────────────────────────────────────────────────────────

let _token: string | null = null;
let _onAuthFailure: (() => void) | null = null;

export function setToken(t: string | null) {
  _token = t;
}
export function getToken() {
  return _token;
}
export function initAuthFailureHandler(cb: () => void) {
  _onAuthFailure = cb;
}

export class ApiError extends Error {
  public readonly code: string | undefined;

  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(apiErrorBodyMessage(body) ?? httpStatusMessage(status));
    this.name = 'ApiError';
    this.code = apiErrorBodyCode(body);
  }
}

type ApiErrorBody = {
  error?: { code?: unknown; message?: unknown } | string;
  message?: unknown;
};

function apiErrorBodyMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = body as ApiErrorBody;
  const message =
    typeof value.error === 'object' && value.error !== null
      ? value.error.message
      : typeof value.error === 'string'
        ? value.error
        : value.message;
  return typeof message === 'string' && message.trim() ? message.trim() : undefined;
}

function apiErrorBodyCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as ApiErrorBody).error;
  if (!error || typeof error !== 'object') return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function httpStatusMessage(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return 'Some information is invalid. Check the form and try again.';
    case 401:
      return 'Your session has expired. Sign in again.';
    case 403:
      return 'You do not have permission to perform this action.';
    case 404:
      return 'The requested item could not be found.';
    case 409:
      return 'This action conflicts with the current state. Refresh and try again.';
    case 413:
      return 'The selected file is too large.';
    case 429:
      return 'Too many requests. Wait a moment and try again.';
    case 502:
    case 503:
    case 504:
      return 'The service is temporarily unavailable. Try again shortly.';
    default:
      return status >= 500
        ? 'Something went wrong on the server. Try again.'
        : 'The request could not be completed. Try again.';
  }
}

export function uploadErrorMessage(status: number): string {
  switch (status) {
    case 403:
      return 'The upload authorization expired. Start the upload again.';
    case 413:
      return 'The selected file is too large.';
    case 429:
      return 'Too many uploads. Wait a moment and try again.';
    case 500:
    case 502:
    case 503:
    case 504:
      return 'The storage service is temporarily unavailable. Try again shortly.';
    default:
      return 'The file could not be uploaded. Try again.';
  }
}

export const UPLOAD_NETWORK_ERROR =
  'Unable to upload the file. Check your connection and try again.';

export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  return fallback;
}

async function fetchApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new Error('Unable to reach the server. Check your connection and try again.', {
      cause: err,
    });
  }
}

async function readResponseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function apiErrorFromResponse(res: Response): Promise<ApiError> {
  return new ApiError(res.status, await readResponseBody(res));
}

async function readApiResponse<T>(res: Response): Promise<T> {
  if (!res.ok) throw await apiErrorFromResponse(res);
  return (await readResponseBody(res)) as T;
}

export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const makeHeaders = (token: string | null): HeadersInit => ({
    ...(init.body != null ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  });

  const res = await fetchApi(path, {
    ...init,
    headers: makeHeaders(_token),
    credentials: 'include',
  });

  if (res.status === 401 && _token) {
    const refreshRes = await fetchApi('/admin/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
    if (refreshRes.ok) {
      const { accessToken } = await readApiResponse<{ accessToken: string }>(refreshRes);
      setToken(accessToken);
      const retry = await fetchApi(path, {
        ...init,
        headers: makeHeaders(accessToken),
        credentials: 'include',
      });
      return readApiResponse<T>(retry);
    }
    setToken(null);
    _onAuthFailure?.();
    throw new ApiError(401, {
      error: { code: 'SESSION_EXPIRED', message: 'Your session has expired. Sign in again.' },
    });
  }

  return readApiResponse<T>(res);
}

// For file downloads (PDF/CSV export) where the response body isn't JSON.
// Mirrors apiFetch's 401-refresh-and-retry dance but resolves to a Blob.
export async function apiFetchBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const makeHeaders = (token: string | null): HeadersInit => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  });

  const res = await fetchApi(path, {
    ...init,
    headers: makeHeaders(_token),
    credentials: 'include',
  });

  if (res.status === 401 && _token) {
    const refreshRes = await fetchApi('/admin/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
    if (refreshRes.ok) {
      const { accessToken } = await readApiResponse<{ accessToken: string }>(refreshRes);
      setToken(accessToken);
      const retry = await fetchApi(path, {
        ...init,
        headers: makeHeaders(accessToken),
        credentials: 'include',
      });
      if (!retry.ok) throw await apiErrorFromResponse(retry);
      return retry.blob();
    }
    setToken(null);
    _onAuthFailure?.();
    throw new ApiError(401, {
      error: { code: 'SESSION_EXPIRED', message: 'Your session has expired. Sign in again.' },
    });
  }

  if (!res.ok) throw await apiErrorFromResponse(res);
  return res.blob();
}

export async function patchAdminPreferences(preferences: { theme?: 'light' | 'dark' | 'system' }) {
  return apiFetch<{ preferences: { theme?: 'light' | 'dark' | 'system' } }>(
    '/admin/me/preferences',
    {
      method: 'PATCH',
      body: JSON.stringify(preferences),
    },
  );
}
