export interface ComfySubmitResult {
  promptId: string;
}

export interface ComfyOutputImage {
  filename: string;
  subfolder: string;
  type: string;
}

function apiHeaders(apiKey: string): Record<string, string> {
  return {
    'X-Api-Key': apiKey,
    'Content-Type': 'application/json',
  };
}

export async function submitPrompt(
  workerUrl: string,
  apiKey: string,
  clientUuid: string,
  prompt: Record<string, unknown>,
  log?: { info: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void },
): Promise<ComfySubmitResult> {
  const url = `${workerUrl.replace(/\/$/, '')}/prompt`;
  log?.info({ url, clientUuid, nodeCount: Object.keys(prompt).length }, 'POST /prompt → ComfyUI');
  const res = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(apiKey),
    body: JSON.stringify({ prompt, client_id: clientUuid }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log?.error({ url, status: res.status, body: text }, 'ComfyUI /prompt failed');
    throw new Error(`ComfyUI /prompt failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { prompt_id: string };
  log?.info({ url, promptId: json.prompt_id }, 'ComfyUI /prompt accepted');
  return { promptId: json.prompt_id };
}

// ComfyUI's /interrupt stops whatever prompt is currently executing on that worker —
// it takes no prompt_id, so this must only be called while this job's prompt is the
// one actually running there (i.e. from inside the GENERATING poll loop, never after).
export async function interruptPrompt(
  workerUrl: string,
  apiKey: string,
  log?: { info: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void },
): Promise<void> {
  const url = `${workerUrl.replace(/\/$/, '')}/interrupt`;
  const res = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(apiKey),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log?.error({ url, status: res.status, body: text }, 'ComfyUI /interrupt failed');
    throw new Error(`ComfyUI /interrupt failed: ${res.status} ${text}`);
  }
  log?.info({ url }, 'ComfyUI /interrupt ok');
}

export async function fetchHistory(
  workerUrl: string,
  apiKey: string,
  promptId: string,
  log?: { info: (obj: unknown, msg: string) => void },
  resultNodeId?: string,
): Promise<ComfyOutputImage[]> {
  const url = `${workerUrl.replace(/\/$/, '')}/history/${promptId}`;
  log?.info({ url }, 'GET /history → ComfyUI');
  const res = await fetch(url, {
    headers: { 'X-Api-Key': apiKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ComfyUI /history failed: ${res.status}`);
  const history = (await res.json()) as Record<string, unknown>;
  const entry = history[promptId] as
    | { outputs?: Record<string, { images?: ComfyOutputImage[] }> }
    | undefined;
  if (!entry?.outputs) return [];

  // Templates with more than one SaveImage node disambiguate via resultNodeId —
  // otherwise the result is whichever output node happens to sort first.
  if (resultNodeId) {
    const node = entry.outputs[resultNodeId];
    const images = node?.images?.filter((img) => img.type === 'output') ?? [];
    // Logs filename+subfolder per image (not just a count) — this is the trace
    // point for diagnosing cross-job image mixups: if two different promptIds
    // ever log the identical {filename, subfolder} pair, that pair is the
    // collision, on this worker, between those two jobs.
    log?.info({ promptId, resultNodeId, images }, 'ComfyUI history fetched');
    return images;
  }

  const images: ComfyOutputImage[] = [];
  for (const node of Object.values(entry.outputs)) {
    // Only collect SaveImage outputs (type=output); skip PreviewImage (type=temp)
    if (node.images) images.push(...node.images.filter((img) => img.type === 'output'));
  }
  log?.info({ promptId, images }, 'ComfyUI history fetched');
  return images;
}

/**
 * Uploads an image to ComfyUI's input folder via /upload/image.
 * Returns the filename ComfyUI assigned (use this in LoadImage nodes).
 */
export async function uploadImageToComfy(
  workerUrl: string,
  apiKey: string,
  imageBytes: Uint8Array,
  filename: string,
  contentType: string,
  log?: { info: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void },
): Promise<string> {
  const url = `${workerUrl.replace(/\/$/, '')}/upload/image`;
  log?.info({ url, filename, bytes: imageBytes.byteLength }, 'POST /upload/image → ComfyUI');
  const form = new FormData();
  form.append('image', new Blob([imageBytes], { type: contentType }), filename);
  form.append('overwrite', 'true');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey }, // no Content-Type — FormData sets multipart boundary
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log?.error({ url, filename, status: res.status, body: text }, 'ComfyUI /upload/image failed');
    throw new Error(`ComfyUI /upload/image failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { name: string };
  log?.info({ url, filename, assignedName: json.name }, 'ComfyUI /upload/image ok');
  return json.name;
}

export async function downloadOutputImage(
  workerUrl: string,
  apiKey: string,
  filename: string,
  subfolder = '',
): Promise<Uint8Array> {
  const url =
    `${workerUrl.replace(/\/$/, '')}/view?filename=${encodeURIComponent(filename)}` +
    `&type=output&subfolder=${encodeURIComponent(subfolder)}`;
  const res = await fetch(url, {
    headers: { 'X-Api-Key': apiKey },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`ComfyUI /view failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
