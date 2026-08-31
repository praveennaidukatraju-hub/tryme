import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessageT, WsAgentFrameT, WsServerFrameT } from '../lib/chatws';
import { connectAgentWs, fetchChatbot } from '../lib/chatws';
import { apiErrorMessage, apiFetch } from '../lib/data';

// Renders the light markdown subset the bot model emits (**bold**, numbered/bulleted
// lists) — mirrors apps/catalogues-web/src/components/chat-widget.tsx so agents see the
// same formatting a user sees, without pulling in a markdown library for one widget.
function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: static text-parse output, never reordered
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: static text-parse output, never reordered
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

function renderMessageContent(content: string) {
  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag key={blocks.length} style={{ margin: '4px 0', paddingLeft: '20px' }}>
        {list.items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static text-parse output, never reordered
          <li key={i}>{renderInline(item)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };

  for (const line of lines) {
    const ordered = line.match(/^\s*\d+\.\s+(.*)/);
    const bulleted = line.match(/^\s*[-*]\s+(.*)/);
    if (ordered) {
      if (!list?.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1] ?? '');
    } else if (bulleted) {
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bulleted[1] ?? '');
    } else {
      flushList();
      if (line.trim()) blocks.push(<div key={blocks.length}>{renderInline(line)}</div>);
    }
  }
  flushList();
  return blocks;
}

interface ConvRow {
  id: string;
  userId: string;
  status: string;
  assignedAgentId: string | null;
  escalationReason: string | null;
  lastMessageAt: string;
  userEmail: string;
  createdAt: string;
}

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export default function ChatInboxPage({ toast }: Props) {
  const [queue, setQueue] = useState<ConvRow[]>([]);
  const [botLive, setBotLive] = useState<ConvRow[]>([]);
  const [myConvs, setMyConvs] = useState<ConvRow[]>([]);
  const [onDuty, setOnDuty] = useState(false);
  const [selectedConv, setSelectedConv] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageT[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState<string | null>(null);
  const wsRef = useRef<Awaited<ReturnType<typeof connectAgentWs>> | null>(null);
  const selectedRef = useRef(selectedConv);
  selectedRef.current = selectedConv;
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [q, b, m, d] = await Promise.all([
      apiFetch<{ rows: ConvRow[] }>('/admin/chatbot/conversations?status=PENDING_HUMAN'),
      apiFetch<{ rows: ConvRow[] }>('/admin/chatbot/conversations?status=BOT'),
      apiFetch<{ rows: ConvRow[] }>('/admin/chatbot/conversations?status=HUMAN'),
      apiFetch<{ on: boolean }>('/admin/chatbot/duty'),
    ]);
    setQueue(q.rows);
    setBotLive(b.rows);
    setMyConvs(m.rows);
    setOnDuty(d.on);
  }, []);

  useEffect(() => {
    void load();
    const p = connectAgentWs((f: WsServerFrameT) => {
      const cur = selectedRef.current;
      if (f.type === 'message' && cur && f.message.conversationId === cur) {
        setMessages((m) => [...m, f.message]);
      } else if (f.type === 'state_change') {
        if (f.conversationId === cur) setStatus(f.status);
        void load();
      } else if (f.type === 'queue_update') {
        void load();
      } else if (f.type === 'typing' && f.conversationId === cur) {
        setTyping(f.role);
        setTimeout(() => setTyping(null), 4000);
      }
    });
    p.then((w) => {
      wsRef.current = w;
    });
    return () => {
      wsRef.current?.close();
    };
  }, [load]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: needed to trigger scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function selectConv(id: string) {
    setSelectedConv(id);
    const msgs = await fetchChatbot<{ messages: ChatMessageT[] }>(
      `/conversations/${id}/messages?limit=100`,
    );
    setMessages(msgs.messages);
    const conv = [...queue, ...botLive, ...myConvs].find((c) => c.id === id);
    if (conv) setStatus(conv.status);
    wsRef.current?.send({ type: 'join', conversationId: id } as WsAgentFrameT);
  }

  async function claim(id: string) {
    try {
      await apiFetch(`/admin/chatbot/conversations/${id}/claim`, { method: 'POST' });
      toast({ title: 'Claimed' });
      void load();
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to claim conversation',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  }

  async function takeover(id: string) {
    try {
      await apiFetch(`/admin/chatbot/conversations/${id}/takeover`, { method: 'POST' });
      toast({ title: 'Took over' });
      void load();
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to take over',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  }

  async function endConv(id: string) {
    try {
      await apiFetch(`/admin/chatbot/conversations/${id}/end`, { method: 'POST' });
      toast({ title: 'Ended' });
      setSelectedConv(null);
      void load();
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to end conversation',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  }

  async function toggleDuty() {
    try {
      const r = await apiFetch<{ on: boolean }>('/admin/chatbot/duty', {
        method: 'POST',
        body: JSON.stringify({ on: !onDuty }),
      });
      setOnDuty(r.on);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to toggle duty',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  }

  function sendMsg() {
    if (!input.trim() || !selectedConv || status !== 'HUMAN') return;
    wsRef.current?.send({
      type: 'message',
      conversationId: selectedConv,
      content: input,
    } as WsAgentFrameT);
    setInput('');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, height: '100%' }}>
      <div className="page-head" style={{ padding: '0 0 16px' }}>
        <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>Chat Inbox</h2>
        <button className="btn" onClick={toggleDuty}>
          {onDuty ? '\u{1F7E2} On Duty' : '\u{26AA} Off Duty'}
        </button>
      </div>

      {/* Conversation panels */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 12,
          marginBottom: selectedConv ? 12 : 0,
        }}
      >
        {/* Queue */}
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-lg)',
            padding: 12,
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>
            Queue ({queue.length})
          </h3>
          {queue.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                color: 'var(--muted-2)',
                padding: '16px 0',
                textAlign: 'center',
              }}
            >
              Empty
            </div>
          ) : (
            queue.map((c) => (
              <div
                key={c.id}
                onClick={() => selectConv(c.id)}
                style={{
                  padding: '8px 10px',
                  borderRadius: 'var(--r)',
                  cursor: 'pointer',
                  background: selectedConv === c.id ? 'var(--accent-soft)' : undefined,
                  borderBottom: '1px solid var(--border)',
                  fontSize: 13,
                }}
              >
                <div style={{ fontWeight: 500 }}>{c.userEmail}</div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 4 }}>
                  {c.escalationReason && <span className="badge">{c.escalationReason}</span>}
                </div>
                <button
                  className="btn sm ghost"
                  style={{ marginTop: 4 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    claim(c.id);
                  }}
                >
                  Claim
                </button>
              </div>
            ))
          )}
        </div>

        {/* Bot Live */}
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-lg)',
            padding: 12,
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>
            Bot Live ({botLive.length})
          </h3>
          {botLive.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                color: 'var(--muted-2)',
                padding: '16px 0',
                textAlign: 'center',
              }}
            >
              Empty
            </div>
          ) : (
            botLive.map((c) => (
              <div
                key={c.id}
                onClick={() => selectConv(c.id)}
                style={{
                  padding: '8px 10px',
                  borderRadius: 'var(--r)',
                  cursor: 'pointer',
                  background: selectedConv === c.id ? 'var(--accent-soft)' : undefined,
                  borderBottom: '1px solid var(--border)',
                  fontSize: 13,
                }}
              >
                <div style={{ fontWeight: 500 }}>{c.userEmail}</div>
                <button
                  className="btn sm ghost"
                  style={{ marginTop: 4 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    takeover(c.id);
                  }}
                >
                  Takeover
                </button>
              </div>
            ))
          )}
        </div>

        {/* My Conversations */}
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-lg)',
            padding: 12,
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>
            My Conversations ({myConvs.length})
          </h3>
          {myConvs.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                color: 'var(--muted-2)',
                padding: '16px 0',
                textAlign: 'center',
              }}
            >
              Empty
            </div>
          ) : (
            myConvs.map((c) => (
              <div
                key={c.id}
                onClick={() => selectConv(c.id)}
                style={{
                  padding: '8px 10px',
                  borderRadius: 'var(--r)',
                  cursor: 'pointer',
                  background: selectedConv === c.id ? 'var(--accent-soft)' : undefined,
                  borderBottom: '1px solid var(--border)',
                  fontSize: 13,
                }}
              >
                <div style={{ fontWeight: 500 }}>{c.userEmail}</div>
                <span className="badge" style={{ marginTop: 4 }}>
                  {c.status}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Conversation pane */}
      {selectedConv && (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-lg)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 16px',
              background: 'var(--surface)',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>
              Status: <strong>{status}</strong>
            </span>
            <button className="btn sm ghost" onClick={() => endConv(selectedConv)}>
              End
            </button>
          </div>
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              maxHeight: 400,
            }}
          >
            {messages.map((m) => (
              <div
                key={m.id}
                style={{
                  alignSelf: m.role === 'user' ? 'flex-start' : 'flex-end',
                  background: m.role === 'user' ? 'var(--surface-2)' : 'var(--accent-soft)',
                  borderRadius: 'var(--r-lg)',
                  padding: '8px 12px',
                  maxWidth: '70%',
                  fontSize: 13,
                }}
              >
                <div
                  style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 2 }}
                >
                  {m.role === 'user' ? 'User' : m.role === 'agent' ? 'You' : 'Bot'}
                </div>
                <div style={{ lineHeight: 1.5 }}>{renderMessageContent(m.content)}</div>
              </div>
            ))}
            {typing && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  fontStyle: 'italic',
                  padding: '4px 0',
                }}
              >
                {typing === 'user' ? 'User' : typing === 'agent' ? 'You' : 'Bot'} is typing…
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
          {status === 'HUMAN' && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                padding: '10px 16px',
                borderTop: '1px solid var(--border)',
                background: 'var(--surface)',
              }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMsg()}
                placeholder="Type a message…"
                style={{
                  flex: 1,
                  padding: '8px 10px',
                  fontSize: 13,
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r)',
                  background: 'var(--bg)',
                  color: 'var(--ink)',
                }}
              />
              <button className="btn primary" onClick={sendMsg}>
                Send
              </button>
            </div>
          )}
        </div>
      )}

      {!selectedConv && (
        <div className="empty">
          <div className="ico">
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              style={{ width: 32, height: 32 }}
            >
              <path d="M2 3h12v9H5l-3 2V3z" />
            </svg>
          </div>
          Select a conversation to start chatting.
        </div>
      )}
    </div>
  );
}
