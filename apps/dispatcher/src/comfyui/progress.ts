import { interruptPrompt } from './client.js';

export interface ProgressUpdate {
  node: string | null;
  value: number;
  max: number;
}

export type ProgressCallback = (update: ProgressUpdate) => void;

/** Thrown when `isCancelled` reports true — distinguishes a user-requested
 *  cancellation from a genuine ComfyUI/network failure so the caller can
 *  refund and mark CANCELLED instead of retrying like a normal failure. */
export class JobCancelledError extends Error {
  constructor(promptId: string) {
    super(`job cancelled by user while ComfyUI prompt ${promptId} was running`);
    this.name = 'JobCancelledError';
  }
}

/**
 * Polls /history/{promptId} every 3s until outputs appear or timeout.
 * More reliable than WebSocket for production use.
 */
export async function waitForCompletion(
  workerUrl: string,
  apiKey: string,
  _clientUuid: string,
  promptId: string,
  timeoutMs: number = 300_000,
  _onProgress?: ProgressCallback,
  log?: {
    info: (obj: unknown, msg: string) => void;
    debug: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  },
  isCancelled?: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `${workerUrl.replace(/\/$/, '')}/history/${promptId}`;
  log?.info({ url, promptId }, 'polling ComfyUI /history for completion');

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));

    if (isCancelled && (await isCancelled())) {
      log?.info({ promptId }, 'cancellation requested — interrupting ComfyUI');
      await interruptPrompt(workerUrl, apiKey, log);
      throw new JobCancelledError(promptId);
    }

    const res = await fetch(url, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      log?.debug({ status: res.status }, 'ComfyUI /history not ready yet');
      continue;
    }

    const history = (await res.json()) as Record<string, unknown>;
    const entry = history[promptId] as
      | {
          outputs?: Record<string, unknown>;
          status?: { status_str?: string; messages?: [string, Record<string, unknown>][] };
        }
      | undefined;

    if (entry?.status?.status_str === 'error') {
      // ComfyUI's /history status_str alone ("error") drops the actual cause — the
      // node/exception detail lives in status.messages under an "execution_error" entry.
      // Surface it so failures are diagnosable from dispatcher logs without needing to
      // separately query the worker or its own process logs.
      const errorMsg = entry.status?.messages?.find(([type]) => type === 'execution_error')?.[1];
      const detail = errorMsg
        ? `${errorMsg.node_type ?? '?'} (node ${errorMsg.node_id ?? '?'}): ${errorMsg.exception_message ?? errorMsg.exception_type ?? 'unknown'}`
        : 'no execution_error detail in ComfyUI history';
      log?.info({ promptId, comfyError: errorMsg }, 'ComfyUI execution error detail');
      throw new Error(`ComfyUI execution error for prompt ${promptId}: ${detail}`);
    }

    if (entry?.outputs && Object.keys(entry.outputs).length > 0) {
      log?.info({ promptId }, 'ComfyUI generation complete');
      return;
    }

    log?.debug({ promptId }, 'ComfyUI still generating…');
  }

  throw new Error(`ComfyUI history polling timeout after ${timeoutMs}ms for prompt ${promptId}`);
}
