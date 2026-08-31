export type ApiErrorBody = {
  error?: { code?: unknown; message?: unknown } | string;
  message?: unknown;
};

export function errorBodyMessage(body: unknown): string | undefined {
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

function errorBodyCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as ApiErrorBody).error;
  if (!error || typeof error !== 'object') return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export function httpStatusMessage(status: number): string {
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

export function downloadErrorMessage(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return 'The download link has expired. Refresh the page and try again.';
    case 404:
      return 'The image is no longer available.';
    case 429:
      return 'Too many downloads. Wait a moment and try again.';
    case 500:
    case 502:
    case 503:
    case 504:
      return 'The image service is temporarily unavailable. Try again shortly.';
    default:
      return 'The image could not be downloaded. Try again.';
  }
}

export class ApiError extends Error {
  public readonly code: string | undefined;

  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(errorBodyMessage(body) ?? httpStatusMessage(status));
    this.name = 'ApiError';
    this.code = errorBodyCode(body);
  }
}

export async function readResponseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function responseError(res: Response): Promise<ApiError> {
  return new ApiError(res.status, await readResponseBody(res));
}

export function networkError(err: unknown): Error {
  if (err instanceof DOMException && err.name === 'AbortError') return err;
  return new Error('Unable to reach the server. Check your connection and try again.', {
    cause: err,
  });
}
