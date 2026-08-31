import { apiErrorFromResponse, getToken } from './data';

export interface ChatMessageT {
  id: string;
  conversationId: string;
  role: string;
  senderId: string | null;
  content: string;
  createdAt: string;
}

export type WsAgentFrameT =
  | { type: 'join'; conversationId: string }
  | { type: 'leave'; conversationId: string }
  | { type: 'message'; conversationId: string; content: string }
  | { type: 'typing'; conversationId: string };

export type WsServerFrameT =
  | { type: 'ready'; conversationId: string; status: string }
  | { type: 'message'; message: ChatMessageT }
  | { type: 'token'; conversationId: string; delta: string }
  | { type: 'typing'; conversationId: string; role: string }
  | { type: 'state_change'; conversationId: string; status: string; reason: string | null }
  | { type: 'queue_update'; pending: number }
  | { type: 'error'; code: string; message: string };

const CHATBOT_URL = (import.meta.env.VITE_CHATBOT_URL as string) || 'http://localhost:4200';

export async function fetchChatbot<T>(path: string): Promise<T> {
  const res = await fetch(`${CHATBOT_URL}${path}`, {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw await apiErrorFromResponse(res);
  return res.json() as Promise<T>;
}

export async function connectAgentWs(
  onFrame: (f: WsServerFrameT) => void,
): Promise<{ send: (f: WsAgentFrameT) => void; close: () => void }> {
  const res = await fetch(`${CHATBOT_URL}/ws-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw await apiErrorFromResponse(res);
  const { ticket } = (await res.json()) as { ticket: string };
  const ws = new WebSocket(`${CHATBOT_URL.replace(/^http/, 'ws')}/ws?ticket=${ticket}`);
  ws.onmessage = (ev) => onFrame(JSON.parse(ev.data as string) as WsServerFrameT);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws failed'));
  });
  return {
    send: (f) => ws.send(JSON.stringify(f)),
    close: () => ws.close(),
  };
}
