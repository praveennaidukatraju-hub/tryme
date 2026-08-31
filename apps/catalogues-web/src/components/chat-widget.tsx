'use client';
import type { ChatMessageT, WsServerFrameT } from '@tryme/types';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { getToken } from '../lib/api';
import { BREAKPOINTS } from '../lib/breakpoints';

const CHATBOT_URL = process.env.NEXT_PUBLIC_CHATBOT_URL || 'http://localhost:4200';

// Renders the light markdown subset the bot model actually emits (**bold**, numbered/
// bulleted lists) — no markdown library in this repo, and the widget has no other rich
// content needs, so a small hand-rolled parser avoids pulling one in.
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

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'BOT' | 'PENDING_HUMAN' | 'HUMAN' | 'CLOSED'>('BOT');
  const [messages, setMessages] = useState<ChatMessageT[]>([]);
  const [typing, setTyping] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const convRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const connect = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    const tRes = await fetch(`${CHATBOT_URL}/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!tRes.ok) return;
    const { ticket } = (await tRes.json()) as { ticket: string };
    const ws = new WebSocket(`${CHATBOT_URL.replace(/^http/, 'ws')}/ws?ticket=${ticket}`);
    ws.onmessage = async (ev) => {
      const f = JSON.parse(ev.data) as WsServerFrameT;
      if (f.type === 'ready') {
        convRef.current = f.conversationId;
        setStatus(f.status);
        const h = await fetch(
          `${CHATBOT_URL}/conversations/${f.conversationId}/messages?limit=50`,
          { headers: { authorization: `Bearer ${getToken()}` } },
        );
        if (h.ok) setMessages(((await h.json()) as { messages: ChatMessageT[] }).messages);
      } else if (f.type === 'message') {
        setTyping(null);
        setMessages((m) => [...m, f.message]);
      } else if (f.type === 'state_change') {
        setStatus(f.status);
        if (f.status === 'CLOSED') convRef.current = null;
      } else if (f.type === 'typing' && f.role !== 'user') {
        setTyping(f.role);
        setTimeout(() => setTyping(null), 4000);
      }
    };
    ws.onclose = () => {
      wsRef.current = null;
    };
    wsRef.current = ws;
  }, []);

  useEffect(() => {
    if (open && !wsRef.current) void connect();
  }, [open, connect]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages.length is a deliberate trigger, not referenced in the body
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  function send() {
    const content = input.trim();
    if (!content || !wsRef.current || status === 'CLOSED') return;
    wsRef.current.send(JSON.stringify({ type: 'message', content }));
    setInput('');
  }

  function talkToHuman() {
    wsRef.current?.send(JSON.stringify({ type: 'escalate' }));
  }

  function reset() {
    setStatus('BOT');
    setMessages([]);
    wsRef.current?.close();
    wsRef.current = null;
    convRef.current = null;
    void connect();
  }

  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            .chat-widget-trigger {
              position: fixed;
              bottom: 24px;
              right: 24px;
              width: 56px;
              height: 56px;
              border-radius: 50%;
              border: none;
              cursor: pointer;
              z-index: 1000;
              background: #521D9C;
              color: #fff;
              display: flex;
              align-items: center;
              justify-content: center;
              box-shadow: 0 4px 12px rgba(82, 29, 156, 0.25);
              transition: transform 0.2s ease, bottom 0.2s ease, right 0.2s ease;
            }
            .chat-widget-panel {
              position: fixed;
              bottom: 92px;
              right: 24px;
              width: 360px;
              max-width: calc(100vw - 32px);
              max-height: 520px;
              border-radius: 12px;
              background: #fff;
              box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
              display: flex;
              flex-direction: column;
              z-index: 1000;
              overflow: hidden;
              font-family: system-ui, -apple-system, sans-serif;
              box-sizing: border-box;
            }
            @media (max-width: ${BREAKPOINTS.sm}px) {
              .chat-widget-trigger {
                bottom: 16px !important;
                right: 16px !important;
                width: 48px !important;
                height: 48px !important;
              }
              .chat-widget-panel {
                bottom: 72px !important;
                right: 16px !important;
                width: calc(100vw - 32px) !important;
                max-height: calc(100vh - 90px) !important;
                height: 440px;
              }
            }
          `,
        }}
      />
      <button type="button" className="chat-widget-trigger" onClick={() => setOpen(!open)}>
        {open ? (
          '✕'
        ) : (
          <svg
            aria-hidden="true"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        )}
      </button>

      {open && (
        <div className="chat-widget-panel">
          <div
            style={{
              padding: '16px',
              borderBottom: '1px solid #f0f0f0',
              background: 'linear-gradient(135deg, #ec4899, #8b5cf6)',
              color: '#fff',
            }}
          >
            <strong>Support</strong>
            <div style={{ fontSize: '12px', opacity: 0.9 }}>
              {status === 'BOT' && 'AI Assistant'}
              {status === 'PENDING_HUMAN' && 'Connecting you to a human…'}
              {status === 'HUMAN' && 'Live agent'}
              {status === 'CLOSED' && 'Conversation ended'}
            </div>
          </div>

          <div
            ref={scrollRef}
            style={{
              flex: 1,
              padding: '12px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              minHeight: '200px',
              maxHeight: '300px',
            }}
          >
            {messages.map((m) => (
              <div
                key={m.id}
                style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '80%',
                  padding: '8px 12px',
                  borderRadius: '12px',
                  fontSize: '14px',
                  lineHeight: 1.4,
                  background:
                    m.role === 'user' ? '#ec4899' : m.role === 'system' ? 'transparent' : '#f5f5f5',
                  color: m.role === 'user' ? '#fff' : m.role === 'system' ? '#999' : '#333',
                  fontStyle: m.role === 'system' ? 'italic' : 'normal',
                  textAlign: m.role === 'system' ? 'center' : 'left',
                }}
              >
                {renderMessageContent(m.content)}
              </div>
            ))}
            {typing && (
              <em style={{ fontSize: '12px', color: '#999', alignSelf: 'flex-start' }}>
                {typing === 'bot' ? 'Assistant is typing…' : 'Agent is typing…'}
              </em>
            )}
          </div>

          {status !== 'CLOSED' ? (
            <div
              style={{
                padding: '12px',
                borderTop: '1px solid #f0f0f0',
                display: 'flex',
                gap: '8px',
              }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
                placeholder="Type a message…"
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: '20px',
                  border: '1px solid #e0e0e0',
                  outline: 'none',
                  fontSize: '14px',
                }}
              />
              <button
                type="button"
                onClick={send}
                style={{
                  padding: '8px 16px',
                  borderRadius: '20px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #ec4899, #8b5cf6)',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                Send
              </button>
            </div>
          ) : (
            <div style={{ padding: '12px', borderTop: '1px solid #f0f0f0', textAlign: 'center' }}>
              <button
                type="button"
                onClick={reset}
                style={{
                  padding: '8px 16px',
                  borderRadius: '20px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #ec4899, #8b5cf6)',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                Start new chat
              </button>
            </div>
          )}

          {status === 'BOT' && (
            <div
              style={{ padding: '8px 12px', textAlign: 'center', borderTop: '1px solid #f0f0f0' }}
            >
              <button
                type="button"
                onClick={talkToHuman}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#8b5cf6',
                  cursor: 'pointer',
                  fontSize: '13px',
                  textDecoration: 'underline',
                }}
              >
                Talk to a human
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
