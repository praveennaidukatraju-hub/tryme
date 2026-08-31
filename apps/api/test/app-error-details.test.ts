import { describe, expect, it } from 'vitest';
import { AppError, withRowIndex } from '../src/lib/errors.js';

describe('AppError details', () => {
  it('defaults details to undefined', () => {
    expect(new AppError('VALIDATION', 400, 'nope').details).toBeUndefined();
  });

  it('carries a details bag', () => {
    const err = new AppError('VALIDATION', 400, 'nope', { rowIndex: 2 });
    expect(err.details).toEqual({ rowIndex: 2 });
  });
});

describe('withRowIndex', () => {
  it('attaches rowIndex to an AppError, preserving code, status and message', () => {
    const out = withRowIndex(new AppError('BAD_CATALOG', 400, 'pose inactive'), 3);
    expect(out).toBeInstanceOf(AppError);
    const app = out as AppError;
    expect(app.code).toBe('BAD_CATALOG');
    expect(app.statusCode).toBe(400);
    expect(app.message).toBe('pose inactive');
    expect(app.details).toEqual({ rowIndex: 3 });
  });

  it('merges rowIndex into an existing details bag', () => {
    const out = withRowIndex(new AppError('VALIDATION', 400, 'x', { field: 'poseIds' }), 1);
    expect((out as AppError).details).toEqual({ field: 'poseIds', rowIndex: 1 });
  });

  it('returns a non-AppError unchanged so 500s are not disguised as 400s', () => {
    const raw = new TypeError('boom');
    expect(withRowIndex(raw, 0)).toBe(raw);
  });
});
