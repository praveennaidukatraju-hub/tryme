import { randomUUID } from 'node:crypto';

export interface PixverseTaskResult {
  taskId: string;
}

export interface PixverseStatusResult {
  status: 'GENERATING' | 'SUCCESS' | 'FAILED';
  videoUrl?: string;
  error?: string;
}

type PixverseResponse<T> = {
  ErrCode?: number;
  ErrMsg?: string;
  Resp?: T;
};

function apiHeaders(apiKey: string): Record<string, string> {
  return {
    'API-KEY': apiKey,
    'Ai-trace-id': randomUUID(),
    'Content-Type': 'application/json',
  };
}

function baseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

function throwForPixverseError(response: PixverseResponse<unknown>): void {
  if (response.ErrCode && response.ErrCode !== 0) {
    throw new Error(
      `PixVerse API error ${response.ErrCode}: ${response.ErrMsg ?? 'unknown error'}`,
    );
  }
}

async function uploadImage(baseUrl: string, apiKey: string, imageUrl: string): Promise<number> {
  const url = `${baseUrl}/openapi/v2/image/upload`;
  const form = new FormData();
  form.set('image_url', imageUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'API-KEY': apiKey,
      'Ai-trace-id': randomUUID(),
    },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PixVerse image upload failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as PixverseResponse<{ img_id?: number }>;
  throwForPixverseError(json);
  if (typeof json.Resp?.img_id !== 'number') {
    throw new Error('PixVerse image upload returned no img_id');
  }
  return json.Resp.img_id;
}

export async function createVideoTask(
  configuredBaseUrl: string,
  apiKey: string,
  imageUrl: string,
  prompt: string,
  log?: { info: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void },
): Promise<PixverseTaskResult> {
  const urlBase = baseUrl(configuredBaseUrl);
  const imageId = await uploadImage(urlBase, apiKey, imageUrl);
  const url = `${urlBase}/openapi/v2/video/img/generate`;
  log?.info({ url }, 'POST -> PixVerse create video task');
  const res = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(apiKey),
    body: JSON.stringify({
      duration: 8,
      img_id: imageId,
      model: 'v6',
      motion_mode: 'normal',
      prompt,
      quality: '720p',
      seed: 0,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log?.error({ url, status: res.status, body: text }, 'PixVerse create task failed');
    throw new Error(`PixVerse create task failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as PixverseResponse<{ video_id?: number }>;
  throwForPixverseError(json);
  if (typeof json.Resp?.video_id !== 'number') {
    throw new Error('PixVerse create task returned no video_id');
  }
  return { taskId: String(json.Resp.video_id) };
}

export async function getVideoTaskStatus(
  configuredBaseUrl: string,
  apiKey: string,
  taskId: string,
): Promise<PixverseStatusResult> {
  const url = `${baseUrl(configuredBaseUrl)}/openapi/v2/video/result/${taskId}`;
  const res = await fetch(url, {
    headers: apiHeaders(apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`PixVerse status check failed: ${res.status}`);

  const json = (await res.json()) as PixverseResponse<{ status?: number; url?: string }>;
  throwForPixverseError(json);
  if (json.Resp?.status === 1 && json.Resp.url) {
    return { status: 'SUCCESS', videoUrl: json.Resp.url };
  }
  if (json.Resp?.status === 7 || json.Resp?.status === 8) {
    return { status: 'FAILED', error: json.ErrMsg };
  }
  return { status: 'GENERATING' };
}

export async function pollVideoTask(
  baseUrl: string,
  apiKey: string,
  taskId: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await getVideoTaskStatus(baseUrl, apiKey, taskId);
    if (result.status === 'SUCCESS' && result.videoUrl) return result.videoUrl;
    if (result.status === 'FAILED') throw new Error(result.error ?? 'PixVerse generation failed');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('PixVerse generation timed out');
}
