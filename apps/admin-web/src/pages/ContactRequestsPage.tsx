import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icons';

import { apiErrorMessage, apiFetch } from '../lib/data';
import type { ContactRequest } from '../types';

const STATUS_LABEL: Record<string, string> = { new: 'New', read: 'Read', done: 'Done' };
const STATUS_BADGE: Record<string, string> = {
  new: 'badge danger dot',
  read: 'badge info dot',
  done: 'badge success dot',
};
const SOURCE_LABELS: Record<string, string> = {
  'app-support': 'App Support',
  'Integrate with Website': 'Integration',
  'Retail Store Kiosk': 'Retail / Kiosk',
  __null__: 'General',
};
const SOURCE_BADGE: Record<string, string> = {
  'app-support': 'badge info',
  'Integrate with Website': 'badge warn',
  'Retail Store Kiosk': 'badge accent',
  __null__: 'badge',
};

function sourceKey(src: string | null) {
  return src === null ? '__null__' : src;
}
function sourceBadgeClass(src: string | null) {
  return SOURCE_BADGE[sourceKey(src)] ?? 'badge';
}

interface SourcesSummary {
  sources: Array<string | null>;
  newBySource: Record<string, number>;
  totalBySource: Record<string, number>;
}

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
  onNav: (_page: string) => void;
}

export default function ContactRequestsPage({ toast }: Props) {
  const [rows, setRows] = useState<ContactRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<'all' | 'new' | 'read' | 'done'>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [summary, setSummary] = useState<SourcesSummary>({
    sources: [],
    newBySource: {},
    totalBySource: {},
  });
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ContactRequest | null>(null);
  const [modalRow, setModalRow] = useState<ContactRequest | null>(null);

  const notifPermRef = useRef(false);
  const prevNewCountRef = useRef<number | null>(null);

  const load = useCallback(
    async (status: string, source: string, silent = false) => {
      if (!silent) setLoading(true);
      try {
        const params = new URLSearchParams({ status, limit: '100' });
        if (source !== 'all') params.set('source', source);
        const data = await apiFetch<{ rows: ContactRequest[]; total: number }>(
          `/admin/contact-requests?${params.toString()}`,
        );
        setRows(data.rows);
        setTotal(data.total);
        return data.rows;
      } catch (e) {
        if (!silent)
          toast({
            kind: 'error',
            title: 'Failed to load contact requests',
            body: apiErrorMessage(e, 'Please try again.'),
          });
        return null;
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [toast],
  );

  const refreshSummary = useCallback(async () => {
    const data = await apiFetch<SourcesSummary>('/admin/contact-requests/sources').catch(
      () => null,
    );
    if (data) setSummary(data);
  }, []);

  useEffect(() => {
    void refreshSummary();
  }, [refreshSummary]);

  useEffect(() => {
    if (
      !notifPermRef.current &&
      'Notification' in window &&
      Notification.permission === 'default'
    ) {
      void Notification.requestPermission();
    }
    notifPermRef.current = true;
  }, []);

  useEffect(() => {
    void load(statusFilter, sourceFilter);

    apiFetch<{ count: number }>('/admin/contact-requests/unread-count')
      .then(({ count }) => {
        prevNewCountRef.current = count;
      })
      .catch(() => {});

    const poll = setInterval(async () => {
      const { count } = await apiFetch<{ count: number }>(
        '/admin/contact-requests/unread-count',
      ).catch(() => ({ count: 0 }));

      const prev = prevNewCountRef.current;
      const isNew = prev !== null && count > prev;

      if (isNew && 'Notification' in window && Notification.permission === 'granted') {
        const delta = count - (prev ?? 0);
        new Notification('New contact request', {
          body: `${delta} new enquir${delta === 1 ? 'y' : 'ies'} received`,
          icon: '/favicon.ico',
        });
      }

      void load(statusFilter, sourceFilter, true);
      void refreshSummary();
      prevNewCountRef.current = count;
    }, 5_000);

    return () => clearInterval(poll);
  }, [load, refreshSummary, statusFilter, sourceFilter]);

  // Escape closes drawer / modal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelected(null);
        setModalRow(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const setStatus = async (id: string, status: ContactRequest['status']) => {
    try {
      const updated = await apiFetch<ContactRequest>(`/admin/contact-requests/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
      if (selected?.id === id) setSelected(updated);
      if (modalRow?.id === id) setModalRow(updated);
      toast({ title: `Marked as ${STATUS_LABEL[status]}` });
      void refreshSummary();
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to update status',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  };

  const renderDetail = (r: ContactRequest) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        <div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 6,
            }}
          >
            Status
          </div>
          <span className={STATUS_BADGE[r.status] ?? 'badge'}>{STATUS_LABEL[r.status]}</span>
        </div>
        <div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 6,
            }}
          >
            Source
          </div>
          <span className={sourceBadgeClass(r.source)}>
            {SOURCE_LABELS[sourceKey(r.source)] ?? r.source ?? 'General'}
          </span>
        </div>
        <div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 6,
            }}
          >
            Received
          </div>
          <div style={{ fontSize: 14 }}>
            {new Date(r.createdAt).toLocaleString('en-IN', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
        </div>
      </div>

      <div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: 6,
          }}
        >
          Message
        </div>
        <div
          style={{
            fontSize: 14,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            color: 'var(--ink)',
          }}
        >
          {r.message || (
            <span style={{ fontStyle: 'italic', color: 'var(--muted-2)' }}>
              No message included
            </span>
          )}
        </div>
      </div>

      {r.attachmentUrl && (
        <div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 6,
            }}
          >
            Attachment
          </div>
          {r.attachmentKey && /\.(jpe?g|png|webp)$/i.test(r.attachmentKey) ? (
            <a href={r.attachmentUrl} target="_blank" rel="noreferrer">
              {/* biome-ignore lint/performance/noImgElement: presigned R2 attachment preview */}
              <img
                src={r.attachmentUrl}
                alt="Support attachment"
                style={{
                  maxWidth: 240,
                  maxHeight: 240,
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  display: 'block',
                }}
              />
            </a>
          ) : (
            <a
              href={r.attachmentUrl}
              target="_blank"
              rel="noreferrer"
              className="btn"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: 'fit-content' }}
            >
              <Icon.Download /> View attachment
            </a>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        {r.status === 'new' && (
          <button
            type="button"
            className="btn"
            onClick={() => void setStatus(r.id, 'read')}
            title="Mark read"
          >
            <Icon.Eye /> View
          </button>
        )}
        {r.status !== 'done' && (
          <button
            type="button"
            className="btn primary"
            onClick={() => void setStatus(r.id, 'done')}
            title="Mark done"
          >
            <Icon.Check /> Ok
          </button>
        )}
        {r.status === 'done' && (
          <button
            type="button"
            className="btn"
            onClick={() => void setStatus(r.id, 'new')}
            title="Reopen"
          >
            <Icon.Refresh /> Reopen
          </button>
        )}
      </div>
    </div>
  );

  const statusFilters: Array<'all' | 'new' | 'read' | 'done'> = ['all', 'new', 'read', 'done'];
  const totalNew = summary.newBySource.__total__ ?? 0;

  // Client-side search
  const q = search.trim().toLowerCase();
  const filtered = q
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.email.toLowerCase().includes(q) ||
          r.message?.toLowerCase().includes(q),
      )
    : rows;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="page-head" style={{ padding: '0 0 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>Contact Requests</h2>
            <p className="lede" style={{ margin: '3px 0 0' }}>
              {total} total
            </p>
          </div>
          {totalNew > 0 && (
            <span
              style={{
                background: 'var(--danger)',
                color: '#fff',
                fontWeight: 700,
                fontSize: 13,
                padding: '3px 10px',
                borderRadius: 99,
              }}
            >
              {totalNew} new
            </span>
          )}
        </div>
        <button className="btn ghost" onClick={() => void load(statusFilter, sourceFilter)}>
          <Icon.Refresh /> Refresh
        </button>
      </div>

      {/* ── Channel summary cards ─────────────────────────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 12,
          marginBottom: 16,
        }}
      >
        {/* All */}
        <button
          className="stat"
          style={{
            borderColor: sourceFilter === 'all' ? 'var(--accent)' : undefined,
            boxShadow: sourceFilter === 'all' ? '0 0 0 2px var(--accent-soft)' : undefined,
          }}
          onClick={() => {
            setSourceFilter('all');
            setStatusFilter('all');
            void load('all', 'all');
          }}
        >
          <span className="lbl">All channels</span>
          <span className="val" style={{ fontSize: 22 }}>
            {summary.newBySource.__total__ ?? 0}
          </span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>new of {total} total</span>
        </button>

        {/* Per-source cards */}
        {summary.sources.map((src) => {
          const key = sourceKey(src);
          const label = SOURCE_LABELS[key] ?? src ?? 'General';
          const nNew = summary.newBySource[key] ?? 0;
          const nTotal = summary.totalBySource[key] ?? 0;
          const isActive = sourceFilter === key;
          return (
            <button
              key={key}
              className="stat"
              style={{
                borderColor: isActive ? 'var(--accent)' : undefined,
                boxShadow: isActive ? '0 0 0 2px var(--accent-soft)' : undefined,
              }}
              onClick={() => {
                setSourceFilter(key);
                setStatusFilter('all');
                void load('all', key);
              }}
            >
              <span className="lbl">{label}</span>
              <span
                className="val"
                style={{ fontSize: 22, color: nNew > 0 ? 'var(--danger)' : undefined }}
              >
                {nNew}
              </span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>new of {nTotal}</span>
            </button>
          );
        })}
      </div>

      {/* ── Filter strip ─────────────────────────────────────────── */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
          marginBottom: 16,
        }}
      >
        {/* Status tabs + Search */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '4px 16px',
            gap: 12,
            minHeight: 52,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--muted)',
              marginRight: 2,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            Status
          </span>
          <div className="tabs" style={{ borderBottom: 'none', marginBottom: 0, flex: 1 }}>
            {statusFilters.map((f) => (
              <button
                key={f}
                className={`tab${statusFilter === f ? ' active' : ''}`}
                onClick={() => {
                  setStatusFilter(f);
                  void load(f, sourceFilter);
                }}
                style={{ textTransform: 'capitalize' }}
              >
                {f === 'all' ? 'All' : STATUS_LABEL[f]}
              </button>
            ))}
          </div>
          <div className="search" style={{ width: 220, flexShrink: 0 }}>
            <Icon.Search />
            <input
              placeholder="Search name, email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* ── Table ────────────────────────────────────────────────── */}
      {loading ? (
        <div
          style={{ color: 'var(--muted)', fontSize: 13, padding: '48px 0', textAlign: 'center' }}
        >
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <div className="ico">
            <Icon.MessageSquare />
          </div>
          {search
            ? `No results for "${search}"`
            : 'No contact requests matching the selected filters.'}
        </div>
      ) : (
        <>
          {/* Desktop / Laptop Table */}
          <div className="desktop-only table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Received</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setModalRow(r)}
                    style={{
                      cursor: 'pointer',
                      background: r.status === 'new' ? 'var(--danger-soft)' : undefined,
                    }}
                  >
                    <td>
                      <span style={{ fontWeight: r.status === 'new' ? 600 : 500 }}>{r.name}</span>
                    </td>
                    <td>
                      <span className="sub">{r.email}</span>
                    </td>
                    <td>
                      <span className={sourceBadgeClass(r.source)}>
                        {SOURCE_LABELS[sourceKey(r.source)] ?? r.source ?? 'General'}
                      </span>
                    </td>
                    <td>
                      <span className={STATUS_BADGE[r.status] ?? 'badge'}>
                        {STATUS_LABEL[r.status]}
                      </span>
                    </td>
                    <td>
                      <span className="mono sub" style={{ fontSize: 11 }}>
                        {new Date(r.createdAt).toLocaleString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </td>
                    <td>
                      <Icon.Chevron />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile / Tablet Card Accordion List */}
          <div className="mobile-only">
            {filtered.map((r) => {
              const isSelected = selected?.id === r.id;
              return (
                <div
                  key={r.id}
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r-lg)',
                    overflow: 'hidden',
                    boxShadow: isSelected ? '0 0 0 2px var(--accent-soft)' : undefined,
                    borderColor: isSelected ? 'var(--accent)' : undefined,
                  }}
                >
                  <div
                    onClick={() => setSelected(isSelected ? null : r)}
                    style={{
                      padding: '16px 20px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                      background: r.status === 'new' ? 'var(--danger-soft)' : 'transparent',
                    }}
                  >
                    <div style={{ fontWeight: r.status === 'new' ? 600 : 500, fontSize: 15 }}>
                      {r.name}
                    </div>
                    <div
                      style={{
                        transform: isSelected ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s',
                        display: 'flex',
                        color: 'var(--muted)',
                      }}
                    >
                      <Icon.Chevron />
                    </div>
                  </div>

                  {isSelected && (
                    <div style={{ padding: '20px', borderTop: '1px solid var(--border)' }}>
                      {renderDetail(r)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Desktop detail modal ────────────────────────────────────── */}
      {modalRow && (
        <div className="modal-overlay" onClick={() => setModalRow(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{modalRow.name}</h3>
              <p className="lede" style={{ margin: '2px 0 0' }}>
                {modalRow.email}
                {modalRow.phone ? ` · ${modalRow.phone}` : ''}
              </p>
            </div>
            <div className="modal-body">{renderDetail(modalRow)}</div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setModalRow(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
