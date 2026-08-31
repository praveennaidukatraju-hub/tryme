import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icons';
import { Pager } from '../components/Pager';
import { apiErrorMessage, apiFetch } from '../lib/data';

const PAGE_SIZE = 20;

const STATUS_FILTERS = [
  { k: 'all', l: 'All' },
  { k: 'paid', l: 'Paid' },
  { k: 'created', l: 'Pending' },
  { k: 'failed', l: 'Failed' },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]['k'];

interface PaymentRow {
  id: string;
  userId: string;
  userEmail: string | null;
  userDisplayName: string | null;
  userTier: string;
  planId: string;
  planName: string | null;
  credits: number;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
  gstin: string | null;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  status: string;
  createdAt: string;
  paidAt: string | null;
  invoiceNumber: string | null;
  invoiceUrl: string | null;
}

function fmtRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function statusTone(status: string): [string, string] {
  if (status === 'paid') return ['success', 'Paid'];
  if (status === 'failed') return ['danger', 'Failed'];
  return ['', 'Pending'];
}

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export default function PaymentsPage({ toast }: Props) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page + 1),
        pageSize: String(PAGE_SIZE),
        status,
      });
      if (query) params.set('search', query);
      const data = await apiFetch<{ items: PaymentRow[]; total: number }>(
        `/admin/payments?${params}`,
      );
      setRows(data.items);
      setTotal(data.total);
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Failed to load payments',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setLoading(false);
    }
  }, [page, query, status, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSearch = (q: string) => {
    setQuery(q);
    setPage(0);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <>
      <div className="desktop-only page-head">
        <div>
          <h1>Payments</h1>
          <p className="lede">
            {loading ? '…' : total} payments — search by invoice number, Razorpay ID, or email.
          </p>
        </div>
        <div className="head-tools">
          <div className="search">
            <Icon.Search />
            <input
              placeholder="Invoice number, Razorpay ID, or email…"
              value={query}
              onChange={(e) => handleSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div
        className="desktop-only"
        style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}
      >
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.k}
            className="btn sm ghost"
            onClick={() => {
              setStatus(f.k);
              setPage(0);
            }}
            style={{
              background: status === f.k ? 'var(--bg-2)' : 'transparent',
              color: status === f.k ? 'var(--text)' : 'var(--muted)',
            }}
          >
            {f.l}
          </button>
        ))}
      </div>

      {/* Mobile header + search + filters */}
      <div className="mobile-only" style={{ marginBottom: 16 }}>
        <h1 style={{ marginBottom: 10 }}>Payments</h1>
        <div className="search" style={{ width: '100%', marginBottom: 10 }}>
          <Icon.Search />
          <input
            placeholder="Invoice number, Razorpay ID, or email…"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.k}
              className={`btn sm ${status === f.k ? 'primary' : 'ghost'}`}
              onClick={() => {
                setStatus(f.k);
                setPage(0);
              }}
            >
              {f.l}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>Loading&hellip;</p>
      ) : (
        <>
          <div className="desktop-only table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Date</th>
                  <th style={{ textAlign: 'left' }}>User</th>
                  <th style={{ textAlign: 'left' }}>Plan</th>
                  <th style={{ textAlign: 'left' }}>Access</th>
                  <th style={{ textAlign: 'right' }}>Credits</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th style={{ textAlign: 'left' }}>Razorpay Payment ID</th>
                  <th style={{ textAlign: 'left' }}>Status</th>
                  <th style={{ textAlign: 'left' }}>Invoice</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const [tone, label] = statusTone(p.status);
                  return (
                    <tr key={p.id}>
                      <td style={{ textAlign: 'left' }}>
                        <span className="mono" style={{ fontSize: 12 }}>
                          {new Date(p.paidAt ?? p.createdAt).toLocaleDateString()}
                        </span>
                      </td>
                      <td style={{ textAlign: 'left' }}>
                        {p.userDisplayName ?? <span style={{ color: 'var(--muted)' }}>—</span>}
                        <span className="sub" style={{ display: 'block' }}>
                          {p.userEmail ?? '—'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'left' }}>{p.planName ?? p.planId}</td>
                      <td style={{ textAlign: 'left', textTransform: 'capitalize' }}>
                        {p.userTier}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="mono">{p.credits.toLocaleString('en-IN')}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="mono">{fmtRupees(p.totalPaise)}</span>
                      </td>
                      <td style={{ textAlign: 'left' }}>
                        <span className="mono" style={{ fontSize: 12 }}>
                          {p.razorpayPaymentId ?? '—'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'left' }}>
                        <span className={`badge ${tone}`}>{label}</span>
                      </td>
                      <td style={{ textAlign: 'left' }}>
                        {p.invoiceUrl ? (
                          <a
                            href={p.invoiceUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          >
                            <Icon.Download />
                            <span className="mono" style={{ fontSize: 12 }}>
                              {p.invoiceNumber}
                            </span>
                          </a>
                        ) : (
                          <span style={{ color: 'var(--muted)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={9}
                      style={{
                        padding: 20,
                        color: 'var(--muted)',
                        fontSize: 13,
                        textAlign: 'center',
                      }}
                    >
                      No payments found for this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mobile-only">
            {rows.map((p) => {
              const [tone, label] = statusTone(p.status);
              return (
                <div
                  key={p.id}
                  className="card"
                  style={{
                    padding: '14px 16px',
                    marginBottom: 10,
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    background: 'var(--surface)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                    }}
                  >
                    <div>
                      <div className="semi" style={{ fontSize: 14 }}>
                        {p.userDisplayName ?? p.userEmail ?? '—'}
                      </div>
                      <div className="sub" style={{ fontSize: 11 }}>
                        {new Date(p.paidAt ?? p.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <span className={`badge ${tone}`}>{label}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ color: 'var(--muted)' }}>{p.planName ?? p.planId}</span>
                    <span className="mono">{fmtRupees(p.totalPaise)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ color: 'var(--muted)' }}>Access</span>
                    <span style={{ textTransform: 'capitalize' }}>{p.userTier}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ color: 'var(--muted)' }}>
                      +{p.credits.toLocaleString('en-IN')} credits
                    </span>
                    {p.invoiceUrl ? (
                      <a
                        href={p.invoiceUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <Icon.Download />
                        {p.invoiceNumber}
                      </a>
                    ) : (
                      <span style={{ color: 'var(--muted)' }}>No invoice</span>
                    )}
                  </div>
                </div>
              );
            })}
            {rows.length === 0 && (
              <div
                style={{
                  textAlign: 'center',
                  color: 'var(--muted)',
                  padding: '2.5rem',
                  border: '1.5px dashed var(--border)',
                  borderRadius: 8,
                }}
              >
                No payments found.
              </div>
            )}
          </div>

          <Pager
            page={page}
            totalPages={totalPages}
            onPage={setPage}
            totalItems={total}
            pageSize={PAGE_SIZE}
          />
        </>
      )}
    </>
  );
}
