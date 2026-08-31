import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobCancelledError, waitForCompletion } from './progress.js';

function mockHistoryResponse(promptId: string, body: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ [promptId]: body }),
    }),
  );
}

describe('waitForCompletion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces the execution_error node/exception detail in the thrown message', async () => {
    mockHistoryResponse('p1', {
      status: {
        status_str: 'error',
        messages: [
          [
            'execution_error',
            {
              node_id: '10',
              node_type: 'SaveImage',
              exception_message: 'Required input is missing: filename_prefix',
            },
          ],
        ],
      },
    });

    await expect(
      waitForCompletion('https://worker.example', 'key', 'client-uuid', 'p1', 5_000),
    ).rejects.toThrow(
      'ComfyUI execution error for prompt p1: SaveImage (node 10): Required input is missing: filename_prefix',
    );
  });

  it('falls back to a generic detail when no execution_error message is present', async () => {
    mockHistoryResponse('p2', { status: { status_str: 'error', messages: [] } });

    await expect(
      waitForCompletion('https://worker.example', 'key', 'client-uuid', 'p2', 5_000),
    ).rejects.toThrow(
      'ComfyUI execution error for prompt p2: no execution_error detail in ComfyUI history',
    );
  });

  it('resolves once outputs appear', async () => {
    mockHistoryResponse('p3', { outputs: { '1': {} }, status: { status_str: 'success' } });

    await expect(
      waitForCompletion('https://worker.example', 'key', 'client-uuid', 'p3', 5_000),
    ).resolves.toBeUndefined();
  });

  it('interrupts the ComfyUI prompt and throws JobCancelledError when isCancelled reports true', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ p4: { status: { status_str: 'success' } } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const isCancelled = vi.fn().mockResolvedValue(true);

    await expect(
      waitForCompletion(
        'https://worker.example',
        'key',
        'client-uuid',
        'p4',
        5_000,
        undefined,
        undefined,
        isCancelled,
      ),
    ).rejects.toThrow(JobCancelledError);

    expect(isCancelled).toHaveBeenCalled();
    // /interrupt must be called before /history is ever polled once cancellation
    // is detected — it's the only call fetch should have received.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.example/interrupt',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('never checks isCancelled when it is omitted — existing callers are unaffected', async () => {
    mockHistoryResponse('p5', { outputs: { '1': {} }, status: { status_str: 'success' } });

    await expect(
      waitForCompletion('https://worker.example', 'key', 'client-uuid', 'p5', 5_000),
    ).resolves.toBeUndefined();
  });
});
