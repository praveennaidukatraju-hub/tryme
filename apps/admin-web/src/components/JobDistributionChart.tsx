import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface DistributionPoint {
  jobId: string;
  jobType: string;
  workerId: string | null;
  e2eMs: number;
  comfyMs: number | null;
  queueMs: number | null;
  attempts: number;
  errorCode: string | null;
  createdAt: string;
  isOutlier: boolean;
}

export interface DistributionBucket {
  bucketMs: number;
  jobType: string;
  count: number;
  q1: number;
  median: number;
  q3: number;
  whiskerLow: number;
  whiskerHigh: number;
  points: DistributionPoint[];
}

interface Props {
  buckets: DistributionBucket[];
  bucketSeconds: number;
  jobTypeOrder: string[];
  /** Currently visible time range. Controlled by the parent so it can refetch. */
  viewFrom: number;
  viewTo: number;
  /** Hard limits pan/zoom can't escape — the window the day selector chose. */
  boundsFrom: number;
  boundsTo: number;
  onViewChange: (from: number, to: number) => void;
  onPointClick: (p: DistributionPoint) => void;
  selectedJobId: string | null;
  loading?: boolean;
}

// Hue encodes the phase, not the job type — the phases are what you compare
// within a single job's bar. Job type is encoded by column position instead.
export const PHASE_COLORS = {
  queue: '#f59e0b',
  comfy: '#3b82f6',
  overhead: '#94a3b8',
} as const;

export const PHASE_LABELS = {
  queue: 'Queue wait',
  comfy: 'ComfyUI',
  overhead: 'Dispatch + I/O',
} as const;

const HEIGHT = 340;
const MARGIN = { top: 10, right: 10, bottom: 42, left: 56 };
const MIN_SPAN_MS = 5 * 60_000;
// Pointer travel below this on release still counts as a click, not a drag.
const DRAG_SLOP_PX = 4;
// A bucket narrower than this is unreadable and unclickable, so widen it even
// though that slightly overstates its time span.
const MIN_COLUMN_PX = 5;

/* ---------- scales & ticks (hand-rolled: the chart owns its own geometry, so
   nothing in a charting library can fight us over bucketing or colour parsing) */

function niceStep(rough: number): number {
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function valueTicks(max: number, count = 5): number[] {
  if (max <= 0) return [0];
  const step = niceStep(max / count);
  const out: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) out.push(v);
  return out;
}

const TIME_STEPS_MS = [
  1_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 10_800_000,
  21_600_000, 43_200_000, 86_400_000, 604_800_000,
];

function timeTicks(from: number, to: number, count = 6): number[] {
  const rough = (to - from) / count;
  const step = TIME_STEPS_MS.find((s) => s >= rough) ?? TIME_STEPS_MS[TIME_STEPS_MS.length - 1];
  // Align to local midnight rather than the epoch so day/hour ticks land on
  // round clock values in the viewer's timezone.
  const tzOffset = new Date(from).getTimezoneOffset() * 60_000;
  const start = Math.ceil((from - tzOffset) / step) * step + tzOffset;
  const out: number[] = [];
  for (let t = start; t <= to; t += step) out.push(t);
  return out;
}

function formatTimeTick(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (spanMs <= 6 * 3_600_000) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (spanMs <= 4 * 86_400_000) {
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Splits a job into three non-overlapping segments that sum exactly to E2E.
 *
 * `comfy_duration_ms` records only the most recent attempt/phase, so on a
 * retried or two-phase job queue+comfy can exceed the wall-clock total. Clamping
 * keeps the bar honest about the total (its height is always exactly E2E) at the
 * cost of understating comfy in those cases; the click detail shows raw values.
 */
function phaseSegments(p: DistributionPoint): { queue: number; comfy: number; overhead: number } {
  const e2e = Math.max(p.e2eMs, 0);
  const queue = Math.min(Math.max(p.queueMs ?? 0, 0), e2e);
  const comfy = Math.min(Math.max(p.comfyMs ?? 0, 0), e2e - queue);
  return { queue, comfy, overhead: e2e - queue - comfy };
}

/**
 * Deterministic [-0.5, 0.5] offset from a job id, so bars at identical
 * durations don't collapse onto one mark — and don't hop between renders the
 * way Math.random would.
 */
function jitterFor(jobId: string): number {
  let h = 0;
  for (let i = 0; i < jobId.length; i++) h = (h * 31 + jobId.charCodeAt(i)) | 0;
  return ((h >>> 0) % 1000) / 1000 - 0.5;
}

export default function JobDistributionChart({
  buckets,
  bucketSeconds,
  jobTypeOrder,
  viewFrom,
  viewTo,
  boundsFrom,
  boundsTo,
  onViewChange,
  onPointClick,
  selectedJobId,
  loading = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(800);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Only ever accept a positive measurement. A zero — from measuring before
    // layout settles, or inside a collapsed ancestor — would otherwise render
    // a zero-width SVG, which looks exactly like the chart having vanished.
    const apply = (w: number) => {
      if (w > 0) setWidth(w);
    };
    const ro = new ResizeObserver(([entry]) => apply(entry?.contentRect.width ?? 0));
    ro.observe(el);
    apply(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(width - MARGIN.left - MARGIN.right, 10);
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const span = Math.max(viewTo - viewFrom, 1);

  const xScale = useCallback(
    (t: number) => MARGIN.left + ((t - viewFrom) / span) * plotW,
    [viewFrom, span, plotW],
  );

  /** Clamp a proposed range to the outer bounds without changing its span. */
  const clampRange = useCallback(
    (from: number, to: number): [number, number] => {
      let s = Math.min(Math.max(to - from, MIN_SPAN_MS), boundsTo - boundsFrom);
      let f = from;
      if (f < boundsFrom) f = boundsFrom;
      if (f + s > boundsTo) f = boundsTo - s;
      if (f < boundsFrom) {
        f = boundsFrom;
        s = boundsTo - boundsFrom;
      }
      return [f, f + s];
    },
    [boundsFrom, boundsTo],
  );

  const commitRange = useCallback(
    (from: number, to: number) => {
      const [f, t] = clampRange(from, to);
      onViewChange(f, t);
    },
    [clampRange, onViewChange],
  );

  // Wheel must be a non-passive listener or the browser scrolls the page
  // instead of letting us zoom; React's onWheel can't guarantee that.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = e.clientX - rect.left;
      // Anchor the zoom on the timestamp under the cursor so it stays put.
      const frac = Math.min(Math.max((px - MARGIN.left) / plotW, 0), 1);
      const anchor = viewFrom + frac * span;
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      const newSpan = span * factor;
      commitRange(anchor - frac * newSpan, anchor + (1 - frac) * newSpan);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [viewFrom, span, plotW, commitRange]);

  // Drag-to-pan.
  //
  // The plot is moved by writing a transform straight onto the SVG group, with
  // no React state involved. Committing the range on every pointermove instead
  // would re-render the whole telemetry page — three recharts charts and the
  // tables — 60+ times a second, which is what made panning feel heavy. The
  // range is committed once, on release; the debounced refetch then runs a
  // single time rather than being restarted every frame.
  const panGroupRef = useRef<SVGGElement>(null);
  const drag = useRef({ active: false, startX: 0, offset: 0, moved: 0 });
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);

  /** How far the plot may slide before it would expose time outside `bounds`. */
  const panLimits = useCallback(() => {
    const pxPerMs = plotW / span;
    return {
      max: (viewFrom - boundsFrom) * pxPerMs, // drag right → earlier time
      min: -(boundsTo - viewTo) * pxPerMs, // drag left → later time
    };
  }, [plotW, span, viewFrom, viewTo, boundsFrom, boundsTo]);

  const applyPan = (offset: number) => {
    panGroupRef.current?.setAttribute('transform', `translate(${offset} 0)`);
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = { active: true, startX: e.clientX, offset: 0, moved: 0 };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current.active) return;
    const { min, max } = panLimits();
    // Measured from the gesture start, not the previous event, so rounding
    // can't accumulate drift over a long drag.
    const raw = e.clientX - drag.current.startX;
    const offset = Math.min(Math.max(raw, min), max);
    drag.current.moved = Math.max(drag.current.moved, Math.abs(raw));
    drag.current.offset = offset;
    applyPan(offset);
  };

  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current.active) return;
    const { offset, moved } = drag.current;
    drag.current.active = false;
    setDragging(false);
    if (moved > DRAG_SLOP_PX) suppressClick.current = true;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (offset === 0) return;
    const dt = -(offset / plotW) * span;
    const [nextFrom, nextTo] = clampRange(viewFrom + dt, viewTo + dt);
    if (nextFrom === viewFrom && nextTo === viewTo) {
      // Nothing to commit means no re-render, so nothing would clear the
      // transform — snap it back here instead of leaving the plot offset.
      applyPan(0);
      return;
    }
    // Otherwise the layout effect clears it once the new range has rendered, so
    // the plot never flashes back to its pre-drag position.
    onViewChange(nextFrom, nextTo);
  };

  // Re-render for a new range means the transform has done its job. viewFrom/
  // viewTo are the trigger rather than values the body reads — dropping them,
  // as the rule suggests, would run this once on mount and leave the plot stuck
  // at its dragged offset.
  // biome-ignore lint/correctness/useExhaustiveDependencies: range change is the trigger
  useLayoutEffect(() => {
    if (!drag.current.active) panGroupRef.current?.removeAttribute('transform');
  }, [viewFrom, viewTo]);

  const handlePointClick = (p: DistributionPoint) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onPointClick(p);
  };

  // Only buckets intersecting the view drive the y-domain, so zooming into a
  // quiet stretch rescales instead of staying squashed by a distant spike.
  const bucketMs = bucketSeconds * 1000;
  const visible = buckets.filter((b) => b.bucketMs + bucketMs >= viewFrom && b.bucketMs <= viewTo);
  let yMax = 0;
  for (const b of visible) {
    yMax = Math.max(yMax, b.whiskerHigh);
    for (const p of b.points) yMax = Math.max(yMax, p.e2eMs);
  }
  yMax = yMax > 0 ? yMax * 1.05 : 1000;
  const yScale = (ms: number) => MARGIN.top + plotH - (ms / yMax) * plotH;

  const typesPresent = jobTypeOrder.filter((t) => buckets.some((b) => b.jobType === t));
  const clipId = 'jdc-plot-clip';
  const atFullExtent = viewFrom <= boundsFrom && viewTo >= boundsTo;
  const canPan = !atFullExtent;

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <svg
        ref={svgRef}
        width={width}
        height={HEIGHT}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => onViewChange(boundsFrom, boundsTo)}
        // width/height MUST be inline styles, not just attributes: tokens.css
        // has a global `svg { width: 1em; height: 1em }` for icons, and a
        // stylesheet rule outranks a presentation attribute — so attributes
        // alone render this chart as a 16px square. Recharts hid this by
        // setting inline styles of its own.
        style={{
          width,
          height: HEIGHT,
          touchAction: 'none',
          // At full extent there is nothing outside the view to pan to, so
          // don't advertise a grab handle the drag can't honour.
          cursor: canPan ? (dragging ? 'grabbing' : 'grab') : 'default',
        }}
        role="img"
        aria-label="Job time breakdown over time. Scroll to zoom, drag to pan."
      >
        <title>Job time breakdown</title>
        <defs>
          {/* Covers the plot plus the x-label strip, so both can slide together
              under one clip while panning. */}
          <clipPath id={clipId}>
            <rect x={MARGIN.left} y={MARGIN.top} width={plotW} height={plotH + 22} />
          </clipPath>
        </defs>

        {/* y grid + labels */}
        {valueTicks(yMax).map((v) => (
          <g key={v}>
            <line
              x1={MARGIN.left}
              x2={MARGIN.left + plotW}
              y1={yScale(v)}
              y2={yScale(v)}
              stroke="var(--border)"
            />
            <text
              x={MARGIN.left - 8}
              y={yScale(v)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fill="var(--muted)"
            >
              {fmtDuration(v)}
            </text>
          </g>
        ))}

        {/* Everything that moves with the time axis lives in this one group, so
            a drag is a single transform write rather than a React re-render. */}
        <g ref={panGroupRef} clipPath={`url(#${clipId})`}>
          {timeTicks(viewFrom, viewTo).map((t) => (
            <text
              key={t}
              x={xScale(t)}
              y={MARGIN.top + plotH + 16}
              textAnchor="middle"
              fontSize={10}
              fill="var(--muted)"
            >
              {formatTimeTick(t, span)}
            </text>
          ))}

          {visible.map((b) => {
            const x0 = xScale(b.bucketMs);
            const x1 = xScale(b.bucketMs + bucketMs);
            const colCount = Math.max(typesPresent.length, 1);
            // Floor the column so a bucket is never a sub-pixel sliver — at wide
            // zoom levels a busy bucket must still be visible and clickable.
            const colW = Math.max((x1 - x0) / colCount, MIN_COLUMN_PX);
            const idx = Math.max(typesPresent.indexOf(b.jobType), 0);
            // Inset slightly so neighbouring buckets stay visually separate.
            const bx = x0 + idx * colW + colW * 0.06;
            const bw = Math.max(colW * 0.88, 1);
            const cx = bx + bw / 2;
            const barW = Math.max(1, Math.min(3, bw / Math.max(b.points.length, 1)));
            const yZero = MARGIN.top + plotH;

            return (
              <g key={`${b.bucketMs}-${b.jobType}`}>
                {/* Q1–Q3 reference box + median, behind the bars */}
                <rect
                  x={bx}
                  y={yScale(b.q3)}
                  width={bw}
                  height={Math.max(yScale(b.q1) - yScale(b.q3), 1)}
                  fill="var(--muted)"
                  fillOpacity={0.1}
                  stroke="var(--muted)"
                  strokeOpacity={0.35}
                />
                <line
                  x1={bx}
                  x2={bx + bw}
                  y1={yScale(b.median)}
                  y2={yScale(b.median)}
                  stroke="var(--muted)"
                  strokeOpacity={0.7}
                  strokeWidth={1.5}
                />
                {/* whisker spine */}
                <line
                  x1={cx}
                  x2={cx}
                  y1={yScale(b.whiskerHigh)}
                  y2={yScale(b.whiskerLow)}
                  stroke="var(--muted)"
                  strokeOpacity={0.4}
                />
                {/* one stacked bar per job: queue, then ComfyUI, then the
                    remaining dispatch/IO overhead, totalling E2E */}
                {b.points.map((p) => {
                  const seg = phaseSegments(p);
                  const px = cx + jitterFor(p.jobId) * (bw * 0.8) - barW / 2;
                  const selected = p.jobId === selectedJobId;
                  const yQueue = yScale(seg.queue);
                  const yComfy = yScale(seg.queue + seg.comfy);
                  const yTop = yScale(p.e2eMs);
                  const band = (a: number, bb: number, fill: string) =>
                    Math.abs(bb - a) < 0.4 ? null : (
                      <rect
                        x={px}
                        y={Math.min(a, bb)}
                        width={barW}
                        height={Math.abs(bb - a)}
                        fill={fill}
                        fillOpacity={selected ? 1 : 0.85}
                      />
                    );
                  return (
                    <g
                      key={p.jobId}
                      style={{ cursor: 'pointer' }}
                      onClick={() => handlePointClick(p)}
                    >
                      {band(yZero, yQueue, PHASE_COLORS.queue)}
                      {band(yQueue, yComfy, PHASE_COLORS.comfy)}
                      {band(yComfy, yTop, PHASE_COLORS.overhead)}
                      {p.isOutlier ? (
                        <rect
                          x={px - 1}
                          y={yTop - 2}
                          width={barW + 2}
                          height={2}
                          fill="var(--danger)"
                        />
                      ) : null}
                      {selected ? (
                        <rect
                          x={px - 1.5}
                          y={yTop - 2}
                          width={barW + 3}
                          height={yZero - yTop + 2}
                          fill="none"
                          stroke="var(--text)"
                        />
                      ) : null}
                      <title>
                        {`${p.jobType}${p.workerId ? ` · ${p.workerId}` : ''}\n${new Date(p.createdAt).toLocaleString()}\nE2E ${fmtDuration(p.e2eMs)} = queue ${fmtDuration(p.queueMs)} + ComfyUI ${fmtDuration(p.comfyMs)} + overhead ${fmtDuration(seg.overhead)}${p.isOutlier ? '\noutlier' : ''}`}
                      </title>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </g>

        {/* axis lines last so they sit above the clipped plot */}
        <line
          x1={MARGIN.left}
          x2={MARGIN.left + plotW}
          y1={MARGIN.top + plotH}
          y2={MARGIN.top + plotH}
          stroke="var(--border)"
        />
      </svg>

      {loading ? (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 10,
            fontSize: 11,
            color: 'var(--muted)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '2px 8px',
          }}
        >
          refining…
        </div>
      ) : null}

      {!atFullExtent ? (
        <button
          type="button"
          className="btn"
          onClick={() => onViewChange(boundsFrom, boundsTo)}
          style={{ position: 'absolute', top: 8, left: MARGIN.left + 8, fontSize: 11 }}
        >
          Show full window
        </button>
      ) : null}
    </div>
  );
}
