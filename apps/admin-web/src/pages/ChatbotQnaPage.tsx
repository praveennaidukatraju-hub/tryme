import { useCallback, useEffect, useState } from 'react';
import { EditDrawer } from '../components/EditDrawer';
import { Icon } from '../components/Icons';
import { apiFetch } from '../lib/data';

interface Qna {
  id: string;
  question: string;
  answer: string;
  tags: string[];
  isActive: boolean;
  updatedAt: string;
}

interface Status {
  activeQna: number;
  embedded: number;
}

export default function ChatbotQnaPage({
  toast,
}: {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}) {
  const [rows, setRows] = useState<Qna[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [editing, setEditing] = useState<Partial<Qna> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, st] = await Promise.all([
      apiFetch<{ rows: Qna[] }>('/admin/chatbot/qna'),
      apiFetch<Status>('/admin/chatbot/status'),
    ]);
    setRows(list.rows);
    setStatus(st);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!editing) return;
    const body = {
      question: editing.question ?? '',
      answer: editing.answer ?? '',
      tags: editing.tags ?? [],
      isActive: editing.isActive ?? true,
    };
    if (editing.id) {
      await apiFetch(`/admin/chatbot/qna/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    } else {
      await apiFetch('/admin/chatbot/qna', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }
    setEditing(null);
    toast({ title: 'Saved' });
    await load();
  }

  async function remove(id: string) {
    await apiFetch(`/admin/chatbot/qna/${id}`, { method: 'DELETE' });
    toast({ title: 'Deleted' });
    await load();
  }

  async function reingest() {
    setBusy(true);
    try {
      const r = await apiFetch<{ ingested: number; durationMs: number }>('/admin/chatbot/ingest', {
        method: 'POST',
      });
      toast({ title: `Ingested ${r.ingested} in ${r.durationMs}ms` });
      await load();
    } catch (e) {
      toast({ kind: 'error', title: `Ingest failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div className="page-head" style={{ padding: '0 0 20px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>Chatbot Q&amp;A</h2>
        </div>
        <button className="btn ghost" onClick={reingest} disabled={busy}>
          <Icon.Refresh /> {busy ? 'Ingesting\u2026' : 'Re-ingest'}
        </button>
      </div>

      {status && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-lg)',
            padding: '10px 16px',
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <span>
            Active Q&A: <strong>{status.activeQna}</strong>
          </span>
          <span>
            Embedded: <strong>{status.embedded}</strong>
          </span>
          {status.activeQna !== status.embedded && (
            <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
              Mismatch — re-ingest needed
            </span>
          )}
        </div>
      )}

      <button
        className="btn primary"
        style={{ alignSelf: 'flex-start', marginBottom: 16 }}
        onClick={() => setEditing({ isActive: true, tags: [] })}
      >
        <Icon.Plus /> New Q&A
      </button>

      {rows.length === 0 ? (
        <div className="empty">
          <div className="ico">
            <Icon.MessageSquare />
          </div>
          No Q&A entries yet.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Question</th>
                <th>Tags</th>
                <th style={{ width: 80 }}>Active</th>
                <th style={{ width: 120 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontSize: 13, fontWeight: 500 }}>{r.question}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {r.tags.map((t) => (
                        <span key={t} className="badge">
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.isActive}
                      onChange={() => {
                        void apiFetch(`/admin/chatbot/qna/${r.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ isActive: !r.isActive }),
                        }).then(() => load());
                      }}
                    />
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn sm ghost" onClick={() => setEditing(r)}>
                        Edit
                      </button>
                      <button className="btn sm ghost" onClick={() => void remove(r.id)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EditDrawer
          onClose={() => setEditing(null)}
          title={`${editing.id ? 'Edit' : 'New'} Q&A`}
          onSave={save}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <div
                style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)', marginBottom: 4 }}
              >
                Question
              </div>
              <textarea
                value={editing.question ?? ''}
                onChange={(e) => setEditing({ ...editing, question: e.target.value })}
                rows={3}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  fontSize: 13,
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r)',
                  background: 'var(--surface)',
                  color: 'var(--ink)',
                  resize: 'vertical',
                  fontFamily: 'var(--sans)',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div>
              <div
                style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)', marginBottom: 4 }}
              >
                Answer
              </div>
              <textarea
                value={editing.answer ?? ''}
                onChange={(e) => setEditing({ ...editing, answer: e.target.value })}
                rows={5}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  fontSize: 13,
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r)',
                  background: 'var(--surface)',
                  color: 'var(--ink)',
                  resize: 'vertical',
                  fontFamily: 'var(--sans)',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div>
              <div
                style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)', marginBottom: 4 }}
              >
                Tags (comma-separated)
              </div>
              <input
                value={(editing.tags ?? []).join(', ')}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    tags: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  fontSize: 13,
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r)',
                  background: 'var(--surface)',
                  color: 'var(--ink)',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={editing.isActive ?? true}
                onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })}
              />
              Active
            </label>
          </div>
        </EditDrawer>
      )}
    </div>
  );
}
