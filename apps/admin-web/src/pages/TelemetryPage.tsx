import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Icon } from '../components/Icons';
import JobDistributionChart, {
  type DistributionBucket,
  type DistributionPoint,
  PHASE_COLORS,
  PHASE_LABELS,
} from '../components/JobDistributionChart';
import { apiErrorMessage, apiFetch } from '../lib/data';

type DayRange = 7 | 14 | 30;

interface JobTypeTelemetry {
  jobType: string;
  sampleCount: number;
  processingP50Ms: number | null;
  processingP95Ms: number | null;
  e2eP50Ms: number | null;
  e2eP95Ms: number | null;
  comfySampleCount: number;
  comfyP50Ms: number | null;
  comfyP95Ms: number | null;
}

interface StreamDepth {
  stream: string;
  depth: number;
}

interface OutcomeCount {
  status: string;
  count: number;
}

interface TelemetryResponse {
  days: number;
  jobTypes: JobTypeTelemetry[];
  queueDepthByStream: StreamDepth[];
  outcomes: OutcomeCount[];
  successRate: number | null;
}

interface DistributionResponse {
  days: number;
  fromMs: number;
  toMs: number;
  bucketSeconds: number;
  totalJobs: number;
  shownJobs: number;
  sampled: boolean;
  buckets: DistributionBucket[];
}

// Zoom re-queries the visible range, so the fetch has to wait for the gesture to
// settle — otherwise every wheel notch fires a request.
const ZOOM_REFETCH_DEBOUNCE_MS = 350;

// If the jobs in the window occupy less than this fraction of it, open zoomed to
// where they actually are. On a real time axis a quiet week renders its one busy
// hour as a ~10px sliver — technically honest, but it reads as an empty chart.
const AUTOFIT_THRESHOLD = 0.6;

/** Time range actually covered by the returned buckets, padded slightly. */
function dataExtent(d: DistributionResponse): { from: number; to: number } | null {
  if (d.buckets.length === 0) return null;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const b of d.buckets) {
    lo = Math.min(lo, b.bucketMs);
    hi = Math.max(hi, b.bucketMs + d.bucketSeconds * 1000);
  }
  const pad = Math.max((hi - lo) * 0.08, 60_000);
  return { from: Math.max(lo - pad, d.fromMs), to: Math.min(hi + pad, d.toMs) };
}

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

interface ChartPoint {
  jobType: string;
  p50: number;
  p95: number;
}

const P50_COLOR = 'var(--accent)';
const P95_COLOR = 'var(--info)';

const OUTCOME_COLORS: Record<string, string> = {
  COMPLETED: 'var(--success)',
  FAILED: 'var(--danger)',
  CANCELLED: 'var(--warn)',
};
const OUTCOME_DEFAULT_COLOR = 'var(--accent)';

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function tickSeconds(v: number): string {
  return v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(1)}s`;
}

// Bucket width now spans 15s to 1 week, since zooming refines it.
function formatBucketWidth(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${seconds / 60} min`;
  if (seconds < 86400) return `${seconds / 3600}h`;
  return seconds === 86400 ? '1 day' : `${seconds / 86400} days`;
}

function PointDetail({ point, onClose }: { point: DistributionPoint; onClose: () => void }) {
  const rows: [string, string][] = [
    ['Job ID', point.jobId],
    ['Type', point.jobType],
    ['Worker', point.workerId ?? '—'],
    ['Started', new Date(point.createdAt).toLocaleString()],
    ['Queue wait', fmtMs(point.queueMs)],
    ['ComfyUI', fmtMs(point.comfyMs)],
    ['End-to-end', fmtMs(point.e2eMs)],
    ['Attempts', String(point.attempts)],
    ['Error', point.errorCode ?? '—'],
  ];
  return (
    <div
      style={{
        marginTop: 12,
        padding: '10px 12px',
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--surface-2)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 13 }}>Job detail{point.isOutlier ? ' · outlier' : ''}</strong>
        <button className="btn" type="button" onClick={onClose} style={{ fontSize: 12 }}>
          Close
        </button>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '6px 16px',
        }}
      >
        {rows.map(([k, v]) => (
          <div key={k} style={{ fontSize: 12 }}>
            <span style={{ color: 'var(--muted)' }}>{k}: </span>
            <span className="mono">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DurationChart({ title, data }: { title: string; data: ChartPoint[] }) {
  if (data.length === 0) {
    return (
      <div className="card">
        <div className="card-head">
          <h3>{title}</h3>
        </div>
        <div className="card-body">
          <p style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>No data yet.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="card-head">
        <h3>{title}</h3>
      </div>
      <div className="card-body">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 24 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="jobType"
              stroke="var(--muted)"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              angle={-25}
              textAnchor="end"
              height={50}
              interval={0}
            />
            <YAxis
              stroke="var(--muted)"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              tickFormatter={tickSeconds}
              width={48}
            />
            <Tooltip
              cursor={{ fill: 'rgba(128,128,128,0.08)' }}
              contentStyle={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value, name) => [`${Number(value).toFixed(2)}s`, name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="p50" name="p50" fill={P50_COLOR} radius={[4, 4, 0, 0]} />
            <Bar dataKey="p95" name="p95" fill={P95_COLOR} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function TelemetryPage({ toast }: Props) {
  const [days, setDays] = useState<DayRange>(7);
  const [data, setData] = useState<TelemetryResponse | null>(null);
  const [dist, setDist] = useState<DistributionResponse | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<DistributionPoint | null>(null);
  const [loading, setLoading] = useState(true);
  const [zooming, setZooming] = useState(false);

  // The outer window the day selector picked; pan/zoom can't escape it.
  const [bounds, setBounds] = useState(() => {
    const to = Date.now();
    return { from: to - 7 * 86_400_000, to };
  });
  // The currently visible slice — updated on every wheel/drag frame for
  // immediate feedback, then refetched once the gesture settles.
  const [view, setView] = useState(bounds);

  const load = useCallback(async () => {
    setLoading(true);
    const to = Date.now();
    const from = to - days * 86_400_000;
    setBounds({ from, to });
    setView({ from, to });
    try {
      const [res, distRes] = await Promise.all([
        apiFetch<TelemetryResponse>(`/admin/telemetry?days=${days}`),
        apiFetch<DistributionResponse>(`/admin/telemetry/distribution?days=${days}`),
      ]);
      setData(res);
      setDist(distRes);
      setSelectedPoint(null);

      // Open on the data rather than on a mostly-empty window. This changes the
      // view, which triggers the range refetch below and refines the buckets —
      // exactly what a manual zoom to the same place would do.
      const extent = dataExtent(distRes);
      if (extent && extent.to - extent.from < (to - from) * AUTOFIT_THRESHOLD) {
        setView(extent);
      }
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to load telemetry',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setLoading(false);
    }
  }, [days, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refetch the distribution for whatever range is visible. Narrowing the range
  // refines the buckets and cuts the job count, so a deep zoom drops below the
  // sampling budget and every job in view becomes visible — the reason zoom
  // re-queries instead of just scaling pixels.
  const viewRef = useRef(view);
  viewRef.current = view;
  const initialRangeRef = useRef(true);

  useEffect(() => {
    // The full-extent range is already covered by load(); don't duplicate it.
    if (initialRangeRef.current) {
      initialRangeRef.current = false;
      return;
    }
    const { from, to } = view;
    setZooming(true);
    const timer = setTimeout(() => {
      apiFetch<DistributionResponse>(
        `/admin/telemetry/distribution?from=${Math.round(from)}&to=${Math.round(to)}`,
      )
        .then((res) => {
          // A slower earlier request must not overwrite a newer view.
          const cur = viewRef.current;
          if (cur.from === from && cur.to === to) setDist(res);
        })
        .catch((e) => {
          toast({
            kind: 'error',
            title: 'Failed to load range',
            body: apiErrorMessage(e, 'Please try again.'),
          });
        })
        .finally(() => setZooming(false));
    }, ZOOM_REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [view, toast]);

  const handleViewChange = useCallback((from: number, to: number) => {
    setView((prev) => (prev.from === from && prev.to === to ? prev : { from, to }));
  }, []);

  // p50/p95 share the same SQL FILTER predicate per metric (see telemetry.routes.ts),
  // so within one metric they're always both null or both present together.
  const processingData: ChartPoint[] =
    data?.jobTypes
      .filter(
        (r): r is JobTypeTelemetry & { processingP50Ms: number; processingP95Ms: number } =>
          r.processingP50Ms !== null,
      )
      .map((r) => ({
        jobType: r.jobType,
        p50: r.processingP50Ms / 1000,
        p95: r.processingP95Ms / 1000,
      })) ?? [];

  const e2eData: ChartPoint[] =
    data?.jobTypes
      .filter(
        (r): r is JobTypeTelemetry & { e2eP50Ms: number; e2eP95Ms: number } => r.e2eP50Ms !== null,
      )
      .map((r) => ({
        jobType: r.jobType,
        p50: r.e2eP50Ms / 1000,
        p95: r.e2eP95Ms / 1000,
      })) ?? [];

  const comfyData: ChartPoint[] =
    data?.jobTypes
      .filter(
        (r): r is JobTypeTelemetry & { comfyP50Ms: number; comfyP95Ms: number } =>
          r.comfySampleCount > 0 && r.comfyP50Ms !== null,
      )
      .map((r) => ({
        jobType: r.jobType,
        p50: r.comfyP50Ms / 1000,
        p95: r.comfyP95Ms / 1000,
      })) ?? [];

  const jobTypeOrder = data?.jobTypes.map((r) => r.jobType) ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Telemetry</h1>
          <p className="lede">
            Queue depth, job outcomes, and processing/E2E/ComfyUI duration by job type — mirrors the
            Grafana Pipeline Overview dashboard's Postgres/Redis-derivable panels, over the last{' '}
            {days} day{days > 1 ? 's' : ''}.
          </p>
        </div>
        <div className="head-tools">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as DayRange)}
            style={{ padding: '8px 12px', borderRadius: 6, fontSize: 13 }}
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
          </select>
          <button className="btn" onClick={load}>
            <Icon.Refresh /> Refresh
          </button>
        </div>
      </div>

      {loading || !data ? (
        <p style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>Loading&hellip;</p>
      ) : (
        <>
          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <div className="stat">
              <div className="lbl">
                <Icon.Activity /> Success rate
              </div>
              <div className="val">
                {data.successRate === null ? '—' : `${Math.round(data.successRate * 100)}%`}
              </div>
              <div className="delta">
                <span style={{ color: 'var(--muted)' }}>
                  completed / (completed + failed), last {days}d
                </span>
              </div>
            </div>
            <div className="stat">
              <div className="lbl">
                <Icon.Clock /> Queue depth (live)
              </div>
              <div className="val">
                {data.queueDepthByStream.reduce((sum, s) => sum + s.depth, 0).toLocaleString()}
              </div>
              <div className="delta">
                <span style={{ color: 'var(--muted)' }}>across all Redis Streams, right now</span>
              </div>
            </div>
          </div>

          <div className="dash-grid-2col" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="card-head">
                <h3>Queue depth by stream</h3>
              </div>
              <div className="card-body">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={data.queueDepthByStream}
                    margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="stream"
                      stroke="var(--muted)"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      stroke="var(--muted)"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                      width={32}
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
                    <Bar dataKey="depth" name="pending" fill={P50_COLOR} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h3>Jobs by outcome</h3>
              </div>
              <div className="card-body">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={data.outcomes} margin={{ top: 4, right: 8, left: 0, bottom: 24 }}>
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="status"
                      stroke="var(--muted)"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      angle={-25}
                      textAnchor="end"
                      height={50}
                      interval={0}
                    />
                    <YAxis
                      stroke="var(--muted)"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                      width={40}
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
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {data.outcomes.map((o) => (
                        <Cell
                          key={o.status}
                          fill={OUTCOME_COLORS[o.status] ?? OUTCOME_DEFAULT_COLOR}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {data.jobTypes.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>
              No completed jobs in this window.
            </p>
          ) : (
            <>
              <div className="dash-grid-2col">
                <DurationChart title="Processing duration by job type" data={processingData} />
                <DurationChart title="End-to-end latency by job type" data={e2eData} />
              </div>
              <div style={{ marginTop: 16 }}>
                <DurationChart title="ComfyUI round-trip by job type" data={comfyData} />
              </div>

              {dist && dist.buckets.length > 0 && (
                <div className="card" style={{ marginTop: 16 }}>
                  <div className="card-head">
                    <h3>Job time breakdown</h3>
                  </div>
                  <div className="card-body">
                    <JobDistributionChart
                      buckets={dist.buckets}
                      jobTypeOrder={jobTypeOrder}
                      bucketSeconds={dist.bucketSeconds}
                      viewFrom={view.from}
                      viewTo={view.to}
                      boundsFrom={bounds.from}
                      boundsTo={bounds.to}
                      onViewChange={handleViewChange}
                      onPointClick={setSelectedPoint}
                      selectedJobId={selectedPoint?.jobId ?? null}
                      loading={zooming}
                    />
                    <div
                      style={{
                        display: 'flex',
                        gap: 16,
                        flexWrap: 'wrap',
                        marginTop: 8,
                        alignItems: 'center',
                      }}
                    >
                      {(Object.keys(PHASE_LABELS) as (keyof typeof PHASE_LABELS)[]).map((k) => (
                        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: 2,
                              background: PHASE_COLORS[k],
                              display: 'inline-block',
                            }}
                          />
                          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                            {PHASE_LABELS[k]}
                          </span>
                        </div>
                      ))}
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        · outlier capped in <span style={{ color: 'var(--danger)' }}>red</span>
                      </span>
                    </div>
                    {jobTypeOrder.length > 1 ? (
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                        Columns within each bucket, left to right:{' '}
                        <span className="semi">{jobTypeOrder.join(' · ')}</span>
                      </div>
                    ) : null}

                    {selectedPoint ? (
                      <PointDetail point={selectedPoint} onClose={() => setSelectedPoint(null)} />
                    ) : null}

                    <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
                      Every bar is one job, rising from zero to its end-to-end time and split into
                      the three phases that compose it — so bar height is E2E, and the coloured
                      sections show where that time went. Click any bar for its worker, exact
                      timings and error. The grey box behind is Q1–Q3 of E2E with the median line;
                      bars capped red are outliers past the 1.5×IQR fence. Scroll to zoom, drag to
                      pan, double-click to reset — zooming re-queries that range, so buckets get
                      finer as you go in (currently {formatBucketWidth(dist.bucketSeconds)}).{' '}
                      {dist.sampled ? (
                        <strong>
                          Showing {dist.shownJobs.toLocaleString()} of{' '}
                          {dist.totalJobs.toLocaleString()} jobs — dots are sampled evenly across
                          buckets, but every outlier is shown and the box statistics use all{' '}
                          {dist.totalJobs.toLocaleString()}. Zoom in to drop below the cap and plot
                          every job in view.
                        </strong>
                      ) : (
                        <>All {dist.totalJobs.toLocaleString()} jobs in this window are plotted.</>
                      )}
                    </p>
                  </div>
                </div>
              )}
            </>
          )}

          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Job type</th>
                  <th style={{ textAlign: 'right' }}>Samples</th>
                  <th style={{ textAlign: 'right' }}>Processing p50</th>
                  <th style={{ textAlign: 'right' }}>Processing p95</th>
                  <th style={{ textAlign: 'right' }}>E2E p50</th>
                  <th style={{ textAlign: 'right' }}>E2E p95</th>
                  <th style={{ textAlign: 'right' }}>ComfyUI p50</th>
                  <th style={{ textAlign: 'right' }}>ComfyUI p95</th>
                </tr>
              </thead>
              <tbody>
                {data.jobTypes.map((r) => (
                  <tr key={r.jobType}>
                    <td style={{ textAlign: 'left' }}>
                      <span className="semi">{r.jobType}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">{r.sampleCount.toLocaleString()}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">{fmtMs(r.processingP50Ms)}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">{fmtMs(r.processingP95Ms)}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">{fmtMs(r.e2eP50Ms)}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">{fmtMs(r.e2eP95Ms)}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">
                        {r.comfySampleCount > 0 ? fmtMs(r.comfyP50Ms) : '—'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">
                        {r.comfySampleCount > 0 ? fmtMs(r.comfyP95Ms) : '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 12 }}>
        Processing duration is measured GENERATING → completed, so it excludes queue-wait and
        worker-selection time (unlike the Grafana "job processing duration" panel, which measures
        the dispatcher's full per-attempt wall time). ComfyUI round-trip only appears for jobs
        processed since this column was added.
      </p>
    </>
  );
}
