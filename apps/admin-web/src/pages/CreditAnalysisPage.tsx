import { useCallback, useEffect, useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { Icon } from '../components/Icons';
import { Pager } from '../components/Pager';
import { apiErrorMessage, apiFetch } from '../lib/data';

type DayRange = '7' | '30' | '90' | 'all';
type SourceFilter = 'all' | 'catalog' | 'tryon' | 'saree' | 'shopify';

const SOURCE_LABELS: Record<SourceFilter, string> = {
  all: 'All sources',
  catalog: 'Catalog generation',
  tryon: 'Tryon (our app)',
  saree: 'Saree',
  shopify: 'Shopify tryon',
};

interface CreditUserRow {
  id: string;
  email: string;
  displayName: string | null;
  tier: string;
  balance: number;
  hasShopifyStore: boolean;
  totalSpent: number;
  totalJobs: number;
  avgCostPerJob: number;
  lastActivityAt: string | null;
}

interface DailySpendPoint {
  date: string;
  spent: number;
}

type JobSource = Exclude<SourceFilter, 'all'>;

interface LedgerEntry {
  id: string;
  delta: number;
  reason: string;
  jobId: string | null;
  createdAt: string;
  source: JobSource | null;
}

const SOURCE_TAG_COLORS: Record<JobSource, string> = {
  catalog: '#8a7cff',
  tryon: '#4caf50',
  saree: '#e08e45',
  shopify: '#95bf47',
};

interface TopProduct {
  shopifyProductId: number;
  title: string | null;
  jobCount: number;
  creditsSpent: number;
}

interface CreditUserDetail {
  id: string;
  email: string;
  displayName: string | null;
  tier: string;
  balance: number;
  hasShopifyStore: boolean;
  dailySpend: DailySpendPoint[];
  ledger: LedgerEntry[];
  topProducts: TopProduct[];
}

const PAGE_SIZE = 20;

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export default function CreditAnalysisPage({ toast }: Props) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [days, setDays] = useState<DayRange>('30');
  const [source, setSource] = useState<SourceFilter>('all');
  const [rows, setRows] = useState<CreditUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CreditUserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [isNavOpen, setIsNavOpen] = useState(false);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [expandedSubTabMap, setExpandedSubTabMap] = useState<
    Record<string, 'graph' | 'ledger' | null>
  >({});
  const [showAllLedgerMap, setShowAllLedgerMap] = useState<Record<string, boolean>>({});
  const [userCreditDetailsMap, setUserCreditDetailsMap] = useState<
    Record<string, CreditUserDetail>
  >({});

  const toggleMobileUserExpand = async (userId: string) => {
    const willExpand = expandedUserId !== userId;
    setExpandedUserId(willExpand ? userId : null);
    if (willExpand) {
      try {
        const params = new URLSearchParams({ days, source });
        const data = await apiFetch<CreditUserDetail>(
          `/admin/credit-analysis/users/${userId}?${params}`,
        );
        setUserCreditDetailsMap((prev) => ({ ...prev, [userId]: data }));
      } catch {
        // Ignore background fetch failure
      }
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page + 1),
        pageSize: String(PAGE_SIZE),
        days,
        source,
      });
      if (query) params.set('search', query);
      const data = await apiFetch<{ items: CreditUserRow[]; total: number }>(
        `/admin/credit-analysis/users?${params}`,
      );
      setRows(data.items);
      setTotal(data.total);
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Failed to load credit analysis',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setLoading(false);
    }
  }, [page, query, days, source, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = (id: string) => {
    setDetailId(id);
  };

  useEffect(() => {
    if (!detailId) return;
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);

    (async () => {
      try {
        const params = new URLSearchParams({ days, source });
        const data = await apiFetch<CreditUserDetail>(
          `/admin/credit-analysis/users/${detailId}?${params}`,
        );
        if (!cancelled) setDetail(data);
      } catch (err) {
        if (!cancelled) {
          toast({
            kind: 'error',
            title: 'Failed to load user detail',
            body: apiErrorMessage(err, 'Please try again.'),
          });
          setDetailId(null);
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetches whenever the opened user, or the day-range/source filter, changes —
    // this is what lets changing the filter while a detail view is open refresh it.
  }, [detailId, days, source, toast]);

  const handleSearch = (q: string) => {
    setQuery(q);
    setPage(0);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  if (detailId) {
    return (
      <>
        <div className="page-head">
          <div>
            <button className="btn ghost" onClick={() => setDetailId(null)}>
              <Icon.Back /> Back to credit analysis
            </button>
            {detail && (
              <>
                <h1 style={{ marginTop: 8 }}>{detail.displayName ?? detail.email}</h1>
                <p className="lede">
                  {detail.email} &middot; {detail.tier}
                </p>
              </>
            )}
          </div>
          <div className="head-tools">
            {detail?.hasShopifyStore && (
              <span
                className="badge dot"
                style={{ background: 'rgba(76,175,80,0.12)', color: 'var(--success, #4caf50)' }}
              >
                Shopify
              </span>
            )}
          </div>
        </div>

        {detailLoading || !detail ? (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading&hellip;</p>
        ) : (
          <>
            <div
              className="kv-grid"
              style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 20 }}
            >
              <div className="kv">
                <span className="k">Balance</span>
                <span className="v">{detail.balance.toLocaleString()}</span>
              </div>
              <div className="kv">
                <span className="k">Ledger entries shown</span>
                <span className="v">{detail.ledger.length}</span>
              </div>
              <div className="kv">
                <span className="k">Filter</span>
                <span className="v">
                  {days === 'all' ? 'All time' : `${days}d`} &middot; {SOURCE_LABELS[source]}
                </span>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-head">
                <h3>Daily spend</h3>
              </div>
              <div className="card-body">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={detail.dailySpend}>
                    <XAxis
                      dataKey="date"
                      stroke="var(--muted)"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: 'rgba(128,128,128,0.08)' }}
                      contentStyle={{
                        background: 'var(--surface-2)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="spent" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {detail.hasShopifyStore && (
              <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-head">
                  <h3>Top products</h3>
                </div>
                <div className="card-body" style={{ padding: 0 }}>
                  {detail.topProducts.length ? (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Product</th>
                            <th style={{ textAlign: 'right' }}>Try-ons</th>
                            <th style={{ textAlign: 'right' }}>Credits spent</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.topProducts.map((p) => (
                            <tr key={p.shopifyProductId}>
                              <td>{p.title ?? `Product #${p.shopifyProductId}`}</td>
                              <td style={{ textAlign: 'right' }}>
                                <span className="mono">{p.jobCount}</span>
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <span className="mono">{p.creditsSpent}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div style={{ padding: 20, color: 'var(--muted)', fontSize: 13 }}>
                      No product try-ons in this window.
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="card">
              <div className="card-head">
                <h3>Recent ledger entries</h3>
                <select
                  className="select"
                  value={source}
                  onChange={(e) => {
                    setSource(e.target.value as SourceFilter);
                    setPage(0);
                  }}
                  style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 8px' }}
                >
                  {(Object.keys(SOURCE_LABELS) as SourceFilter[]).map((s) => (
                    <option key={s} value={s}>
                      {SOURCE_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="card-body" style={{ padding: 0 }}>
                {detail.ledger.length ? (
                  detail.ledger.map((l) => (
                    <div
                      key={l.id}
                      style={{
                        padding: '10px 18px',
                        borderBottom: '1px solid var(--border)',
                        display: 'flex',
                        gap: 10,
                        alignItems: 'center',
                      }}
                    >
                      <span
                        className="mono"
                        style={{ color: l.delta < 0 ? 'var(--danger)' : 'var(--success, #4caf50)' }}
                      >
                        {l.delta > 0 ? '+' : ''}
                        {l.delta}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{l.reason}</span>
                      {l.source ? (
                        <span
                          className="badge dot"
                          style={{
                            background: `${SOURCE_TAG_COLORS[l.source]}1f`,
                            color: SOURCE_TAG_COLORS[l.source],
                            fontSize: 10,
                          }}
                        >
                          {SOURCE_LABELS[l.source]}
                        </span>
                      ) : (
                        <span
                          className="badge dot"
                          style={{ background: 'var(--bg-2)', color: 'var(--muted)', fontSize: 10 }}
                        >
                          Account
                        </span>
                      )}
                      <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>
                        {new Date(l.createdAt).toLocaleString()}
                      </span>
                    </div>
                  ))
                ) : (
                  <div style={{ padding: 20, color: 'var(--muted)', fontSize: 13 }}>
                    No ledger entries in this window.
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <>
      {/* Desktop Header */}
      <div className="desktop-only page-head">
        <div>
          <h1>Credit Analysis</h1>
          <p className="lede">{loading ? '…' : total} users ranked by credit spend.</p>
        </div>
        <div className="head-tools">
          <div className="search">
            <Icon.Search />
            <input
              placeholder="Search by name or email…"
              value={query}
              onChange={(e) => handleSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div
        className="desktop-only"
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: 4 }}>
          {(['7', '30', '90', 'all'] as DayRange[]).map((d) => (
            <button
              key={d}
              className="btn sm ghost"
              onClick={() => {
                setDays(d);
                setPage(0);
              }}
              style={{
                background: days === d ? 'var(--bg-2)' : 'transparent',
                color: days === d ? 'var(--text)' : 'var(--muted)',
              }}
            >
              {d === 'all' ? 'All time' : `${d}d`}
            </button>
          ))}
        </div>
        <select
          className="select"
          value={source}
          onChange={(e) => {
            setSource(e.target.value as SourceFilter);
            setPage(0);
          }}
        >
          {(Object.keys(SOURCE_LABELS) as SourceFilter[]).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {/* Mobile Navigation Accordion Bar */}
      <div className="mobile-only" style={{ marginBottom: 16 }}>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setIsNavOpen((v) => !v)}
            style={{
              width: '100%',
              padding: '12px 16px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              cursor: 'pointer',
              color: 'var(--ink)',
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon.Search />
              <span>Search &amp; Filters</span>
            </div>
            <span
              style={{
                transform: isNavOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s',
                display: 'inline-flex',
              }}
            >
              <Icon.Chevron />
            </span>
          </button>

          {isNavOpen && (
            <>
              <div
                onClick={() => setIsNavOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 99, background: 'transparent' }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  left: 0,
                  right: 0,
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  boxShadow: 'var(--shadow-lg)',
                  zIndex: 100,
                  padding: '14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  maxHeight: '420px',
                  overflowY: 'auto',
                }}
              >
                {/* Search Input starting first */}
                <div className="search" style={{ width: '100%' }}>
                  <Icon.Search />
                  <input
                    placeholder="Search by name or email…"
                    value={query}
                    onChange={(e) => handleSearch(e.target.value)}
                  />
                </div>

                {/* Time Range Filter */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="sub" style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Time Range:
                  </span>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
                    {(['7', '30', '90', 'all'] as DayRange[]).map((d) => (
                      <button
                        key={d}
                        type="button"
                        className={`btn sm ${days === d ? 'primary' : 'ghost'}`}
                        onClick={() => {
                          setDays(d);
                          setPage(0);
                        }}
                        style={{ justifyContent: 'center', fontSize: 12 }}
                      >
                        {d === 'all' ? 'All' : `${d}d`}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Source Filter Dropdown */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="sub" style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Source Filter:
                  </span>
                  <select
                    className="select"
                    value={source}
                    onChange={(e) => {
                      setSource(e.target.value as SourceFilter);
                      setPage(0);
                    }}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: 6, fontSize: 13 }}
                  >
                    {(Object.keys(SOURCE_LABELS) as SourceFilter[]).map((s) => (
                      <option key={s} value={s}>
                        {SOURCE_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </>
          )}
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
                  <th style={{ textAlign: 'left' }}>User</th>
                  <th style={{ textAlign: 'right' }}>Spent</th>
                  <th style={{ textAlign: 'right' }}>Jobs</th>
                  <th style={{ textAlign: 'right' }}>Avg/job</th>
                  <th style={{ textAlign: 'right' }}>Last activity</th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => openDetail(r.id)} style={{ cursor: 'pointer' }}>
                    <td style={{ textAlign: 'left' }}>
                      <span
                        className="semi"
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        {r.displayName ?? <span style={{ color: 'var(--muted)' }}>{r.email}</span>}
                        {r.hasShopifyStore && (
                          <span
                            className="badge dot"
                            style={{
                              background: 'rgba(76,175,80,0.12)',
                              color: 'var(--success, #4caf50)',
                              fontSize: 10,
                            }}
                          >
                            Shopify
                          </span>
                        )}
                      </span>
                      {r.displayName && (
                        <span className="sub" style={{ display: 'block' }}>
                          {r.email}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">{r.totalSpent.toLocaleString()}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">{r.totalJobs.toLocaleString()}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">{r.avgCostPerJob}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">
                        {r.lastActivityAt ? new Date(r.lastActivityAt).toLocaleDateString() : '—'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">{r.balance.toLocaleString()}</span>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      style={{
                        padding: 20,
                        color: 'var(--muted)',
                        fontSize: 13,
                        textAlign: 'center',
                      }}
                    >
                      No users found for this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mobile-only">
            {rows.map((r) => {
              const isExpanded = expandedUserId === r.id;
              const userDetail = userCreditDetailsMap[r.id];
              const activeSubTab = expandedSubTabMap[r.id] ?? null;
              const showAllLedger = showAllLedgerMap[r.id] ?? false;

              return (
                <div
                  key={r.id}
                  className="card"
                  style={{
                    padding: 0,
                    overflow: 'hidden',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    background: 'var(--surface)',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => void toggleMobileUserExpand(r.id)}
                    style={{
                      padding: '14px 16px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                      userSelect: 'none',
                      background: 'none',
                      border: 'none',
                      width: '100%',
                      textAlign: 'left',
                      color: 'inherit',
                      fontFamily: 'inherit',
                      fontSize: 'inherit',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          className="semi"
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontSize: 15,
                            color: 'var(--ink)',
                            fontWeight: 600,
                          }}
                        >
                          {r.displayName ?? r.email}
                        </div>
                        {r.displayName && (
                          <div
                            className="sub"
                            style={{ fontSize: 11, marginTop: 2, color: 'var(--muted)' }}
                          >
                            {r.email}
                          </div>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8 }}>
                      {r.hasShopifyStore && (
                        <span
                          className="badge dot"
                          style={{
                            background: 'rgba(76,175,80,0.12)',
                            color: 'var(--success, #4caf50)',
                            fontSize: 10,
                          }}
                        >
                          Shopify
                        </span>
                      )}
                      <span
                        style={{
                          color: 'var(--muted-2)',
                          transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                          transition: 'transform 0.2s',
                          display: 'inline-flex',
                        }}
                      >
                        <Icon.Chevron />
                      </span>
                    </div>
                  </button>

                  {isExpanded && (
                    <div
                      style={{
                        padding: '16px',
                        borderTop: '1px solid var(--border)',
                        background: 'var(--surface-2)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 14,
                        fontSize: 13,
                      }}
                    >
                      {/* 1. Credit Summary Details */}
                      <div
                        style={{
                          background: 'var(--surface)',
                          padding: '12px',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>
                          Credit Summary
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <span style={{ color: 'var(--muted)' }}>Plan</span>
                          <span className="badge" style={{ textTransform: 'capitalize' }}>
                            {r.tier}
                          </span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <span style={{ color: 'var(--muted)' }}>Spent</span>
                          <span className="mono bold">{r.totalSpent.toLocaleString()} credits</span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <span style={{ color: 'var(--muted)' }}>Jobs</span>
                          <span className="mono">{r.totalJobs.toLocaleString()}</span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <span style={{ color: 'var(--muted)' }}>Avg / Job</span>
                          <span className="mono">{r.avgCostPerJob} credits</span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <span style={{ color: 'var(--muted)' }}>Last Activity</span>
                          <span className="sub">
                            {r.lastActivityAt
                              ? new Date(r.lastActivityAt).toLocaleDateString()
                              : 'No activity'}
                          </span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <span style={{ color: 'var(--muted)' }}>Balance</span>
                          <span className="mono bold" style={{ color: 'var(--ink)', fontSize: 14 }}>
                            {r.balance.toLocaleString()} credits
                          </span>
                        </div>
                      </div>

                      {/* Sub-tabs for Daily Spent & Recent Ledger */}
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          className={`btn sm ${activeSubTab === 'graph' ? 'primary' : 'ghost'}`}
                          onClick={() =>
                            setExpandedSubTabMap((prev) => ({
                              ...prev,
                              [r.id]: prev[r.id] === 'graph' ? null : 'graph',
                            }))
                          }
                          style={{ flex: 1, justifyContent: 'center' }}
                        >
                          Daily Spent Graph
                        </button>
                        <button
                          className={`btn sm ${activeSubTab === 'ledger' ? 'primary' : 'ghost'}`}
                          onClick={() =>
                            setExpandedSubTabMap((prev) => ({
                              ...prev,
                              [r.id]: prev[r.id] === 'ledger' ? null : 'ledger',
                            }))
                          }
                          style={{ flex: 1, justifyContent: 'center' }}
                        >
                          Recent Ledger
                        </button>
                      </div>

                      {/* 2. Daily Spent Section */}
                      {activeSubTab === 'graph' && (
                        <div
                          style={{
                            background: 'var(--surface)',
                            padding: '12px',
                            borderRadius: 8,
                            border: '1px solid var(--border)',
                          }}
                        >
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 700,
                              color: 'var(--ink)',
                              marginBottom: 10,
                            }}
                          >
                            Daily Credit Spend Chart
                          </div>
                          {userDetail?.dailySpend && userDetail.dailySpend.length > 0 ? (
                            <ResponsiveContainer width="100%" height={180}>
                              <BarChart data={userDetail.dailySpend}>
                                <XAxis
                                  dataKey="date"
                                  stroke="var(--muted)"
                                  fontSize={10}
                                  tickLine={false}
                                  axisLine={false}
                                />
                                <Tooltip
                                  cursor={{ fill: 'rgba(128,128,128,0.08)' }}
                                  contentStyle={{
                                    background: 'var(--surface-2)',
                                    border: '1px solid var(--border)',
                                    borderRadius: 8,
                                    fontSize: 11,
                                  }}
                                />
                                <Bar dataKey="spent" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                              </BarChart>
                            </ResponsiveContainer>
                          ) : (
                            <span className="sub" style={{ fontSize: 12, color: 'var(--muted)' }}>
                              Loading daily spend graph&hellip;
                            </span>
                          )}
                        </div>
                      )}

                      {/* 3. Recent Ledger Entries Section */}
                      {activeSubTab === 'ledger' && (
                        <div
                          style={{
                            background: 'var(--surface)',
                            padding: '12px',
                            borderRadius: 8,
                            border: '1px solid var(--border)',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              marginBottom: 10,
                            }}
                          >
                            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>
                              Recent Ledger Entries
                            </span>
                            <span className="badge dot" style={{ fontSize: 10 }}>
                              {SOURCE_LABELS[source]}
                            </span>
                          </div>
                          {(() => {
                            const activeLedger = userDetail?.ledger
                              ? source === 'all'
                                ? userDetail.ledger
                                : userDetail.ledger.filter((l) => l.source === source)
                              : [];

                            if (!activeLedger.length) {
                              return (
                                <span
                                  className="sub"
                                  style={{ fontSize: 12, color: 'var(--muted)' }}
                                >
                                  {userDetail
                                    ? `No ledger entries found for ${SOURCE_LABELS[source]}.`
                                    : 'Loading ledger data…'}
                                </span>
                              );
                            }

                            return (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {(showAllLedger ? activeLedger : activeLedger.slice(0, 3)).map(
                                  (l) => (
                                    <div
                                      key={l.id}
                                      style={{
                                        padding: '8px 10px',
                                        borderRadius: 6,
                                        background: 'var(--surface-2)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        fontSize: 12,
                                      }}
                                    >
                                      <div
                                        style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                                      >
                                        <span
                                          className="mono bold"
                                          style={{
                                            color:
                                              l.delta < 0
                                                ? 'var(--danger)'
                                                : 'var(--success, #4caf50)',
                                          }}
                                        >
                                          {l.delta > 0 ? '+' : ''}
                                          {l.delta}
                                        </span>
                                        <span style={{ color: 'var(--ink)', fontSize: 11 }}>
                                          {l.reason}
                                        </span>
                                      </div>
                                      <span style={{ fontSize: 10, color: 'var(--muted)' }}>
                                        {new Date(l.createdAt).toLocaleDateString()}
                                      </span>
                                    </div>
                                  ),
                                )}
                                {activeLedger.length > 3 && (
                                  <button
                                    className="btn sm ghost"
                                    onClick={() =>
                                      setShowAllLedgerMap((prev) => ({
                                        ...prev,
                                        [r.id]: !prev[r.id],
                                      }))
                                    }
                                    style={{ width: '100%', marginTop: 4 }}
                                  >
                                    {showAllLedger
                                      ? 'Show less'
                                      : `Show more (${activeLedger.length - 3} more)`}
                                  </button>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  )}
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
                No users found.
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
