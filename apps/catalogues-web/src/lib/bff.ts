import { httpStatusMessage } from './errors';

export async function safeJson(res: Response): Promise<[unknown, boolean]> {
  const text = await res.text().catch(() => '');
  try {
    return [JSON.parse(text), res.ok];
  } catch {
    return [{ error: { code: 'UPSTREAM_ERROR', message: httpStatusMessage(res.status) } }, false];
  }
}
