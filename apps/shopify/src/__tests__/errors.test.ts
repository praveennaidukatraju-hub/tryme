import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api';
import { classifyError } from '../lib/errors';

describe('classifyError', () => {
  it('treats SHOPIFY_REAUTH_REQUIRED as an info, non-retryable state', () => {
    const result = classifyError(new ApiError(403, 'forbidden', 'SHOPIFY_REAUTH_REQUIRED'));
    expect(result.tone).toBe('info');
    expect(result.retryable).toBe(false);
    expect(result.code).toBe('SHOPIFY_REAUTH_REQUIRED');
  });

  it('gives RATE_LIMIT a friendlier, retryable warning', () => {
    const result = classifyError(new ApiError(429, 'Too many requests', 'RATE_LIMIT'));
    expect(result.tone).toBe('warning');
    expect(result.retryable).toBe(true);
    expect(result.message).not.toBe('Too many requests');
  });

  it('classifies a tagged TIMEOUT Error as a retryable warning', () => {
    const err = Object.assign(
      new Error('Request timed out — check your connection and try again.'),
      {
        code: 'TIMEOUT',
      },
    );
    const result = classifyError(err);
    expect(result.tone).toBe('warning');
    expect(result.retryable).toBe(true);
    expect(result.status).toBeNull();
  });

  it('classifies a tagged NETWORK_ERROR Error as a retryable warning', () => {
    const err = Object.assign(
      new Error("Couldn't reach TryMe — check your connection and try again."),
      {
        code: 'NETWORK_ERROR',
      },
    );
    const result = classifyError(err);
    expect(result.tone).toBe('warning');
    expect(result.retryable).toBe(true);
  });

  it('marks CONFIG/INTERNAL as critical and not retryable, with a support hint', () => {
    const result = classifyError(new ApiError(500, 'missing env var', 'CONFIG'));
    expect(result.tone).toBe('critical');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('contact support');
  });

  it('marks SHOPIFY (upstream) failures as critical but retryable', () => {
    const result = classifyError(new ApiError(502, 'Shopify request failed', 'SHOPIFY'));
    expect(result.tone).toBe('critical');
    expect(result.retryable).toBe(true);
  });

  it('gives LOCKED (our own lock contention, not an upstream Shopify failure) a retryable warning', () => {
    const result = classifyError(
      new ApiError(409, 'Token refresh in progress, retry shortly', 'LOCKED'),
    );
    expect(result.tone).toBe('warning');
    expect(result.retryable).toBe(true);
    expect(result.message).toBe('Token refresh in progress, retry shortly');
  });

  it('treats any other 5xx as retryable even without a recognized code', () => {
    const result = classifyError(new ApiError(503, 'temporarily unavailable'));
    expect(result.retryable).toBe(true);
  });

  it('leaves an ordinary 4xx message untouched and non-retryable', () => {
    const result = classifyError(new ApiError(400, 'unknown pack', 'BAD_REQUEST'));
    expect(result.tone).toBe('critical');
    expect(result.retryable).toBe(false);
    expect(result.message).toBe('unknown pack');
  });

  it('falls back to a generic message for a non-Error thrown value', () => {
    const result = classifyError('not an error');
    expect(result.message).toBe('Something went wrong.');
    expect(result.code).toBeNull();
  });
});
