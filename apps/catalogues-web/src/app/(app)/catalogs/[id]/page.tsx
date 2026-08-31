'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  DownloadIcon,
  DriveIcon,
  FullscreenIcon,
  ImageDownIcon,
  MonitorPlayIcon,
  SpinnerIcon,
  TrashIcon,
  XIcon,
} from '@/components/icons';
import { SupportModal } from '@/components/SupportModal';
import { C } from '@/components/tokens';
import { TopBar } from '@/components/topbar';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useGoogleDriveStatus } from '@/hooks/use-google-drive-status';
import { useJobStream } from '@/hooks/use-job-stream';
import { api } from '@/lib/api';
import { ApiError, downloadErrorMessage } from '@/lib/errors';
import { GOOGLE_DRIVE_ENABLED, REGENERATE_ENABLED } from '@/lib/feature-flags';

const REGENERATE_LIMIT_SUPPORT_MESSAGE =
  "I've used all 5 free regenerations for today and would like help getting more.";

async function concurrentPool<T>(
  fns: Array<() => Promise<T>>,
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  let i = 0;
  async function worker() {
    while (i < fns.length) {
      const idx = i++;
      const fn = fns[idx];
      if (!fn) continue;
      try {
        results[idx] = { status: 'fulfilled', value: await fn() };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, fns.length) }, worker));
  return results;
}

interface Job {
  id: string;
  status: string;
  createdAt: string;
  creditsCharged: number;
  watermark: boolean;
  watermarkVersion?: number;
  assetKind?: string;
  alreadyDownloaded?: boolean;
  parentJobId?: string | null;
}
interface CatalogueDetail {
  catalogueId: string;
  jobs: Job[];
  garmentUrl?: string | null;
  currentPlanWatermark: boolean;
}

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

// Mirrors FREE_REGENERATE_DAILY_LIMIT in apps/api/src/modules/jobs/regenerate.ts —
// display-only copy; the actual cap is enforced server-side.
const FREE_REGENERATE_DAILY_LIMIT = 5;

// [min%, max%, durationMs] for each non-terminal stage
const STAGE_RANGES: Record<string, [number, number, number]> = {
  PENDING_MANNEQUIN: [0, 3, 0],
  QUEUED: [0, 5, 0],
  PREPROCESSING: [5, 25, 30_000],
  GENERATING: [25, 88, 240_000],
  UPLOADING: [88, 96, 20_000],
};

function useAnimatedProgress(status: string): number {
  const range = STAGE_RANGES[status];
  const [pct, setPct] = useState(range?.[0] ?? 100);

  useEffect(() => {
    if (!range || range[2] === 0) {
      setPct(range?.[0] ?? 100);
      return;
    }
    const [min, max, dur] = range;
    setPct(min);
    const start = Date.now();
    const id = setInterval(() => {
      const t = Math.min((Date.now() - start) / dur, 1);
      // ease-out: slows as it approaches the ceiling
      setPct(min + (max - min) * (1 - (1 - t) ** 2));
    }, 800);
    return () => clearInterval(id);
  }, [range]);

  return Math.round(pct);
}

function ProgressRing({
  pct,
  size = 56,
  stroke = 4,
}: {
  pct: number;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const filled = (pct / 100) * circ;
  return (
    <svg
      width={size}
      height={size}
      aria-hidden="true"
      style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.15)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#F55C7A"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circ - filled}`}
      />
    </svg>
  );
}

function ordinal(n: number): string {
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return `${n}th`;
}

function ImageCard({
  job,
  catalogueId,
  queuePosition,
  garmentUrl,
  onZoom,
  onRegenerate,
}: {
  job: Job;
  catalogueId: string;
  queuePosition: number;
  garmentUrl?: string | null;
  onZoom: (data: { url: string; job: Job }) => void;
  onRegenerate: (jobId: string) => void;
}) {
  const isCompleted = job.status === 'COMPLETED';
  const isFailed = job.status === 'FAILED';
  const isQueued = job.status === 'QUEUED';
  const isActive = !TERMINAL.includes(job.status) && !isQueued;

  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const driveStatus = useGoogleDriveStatus();
  const [savingToDrive, setSavingToDrive] = useState(false);
  const qc = useQueryClient();

  const pct = useAnimatedProgress(job.status);

  async function saveToDrive() {
    if (savingToDrive) return;
    if (driveStatus.data?.status !== 'CONNECTED') {
      window.location.href = '/api/integrations/google-drive/connect';
      return;
    }
    setSavingToDrive(true);
    try {
      await api.post(`/v1/jobs/${job.id}/export/google-drive`, {});
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not save to Google Drive. Try again.');
    } finally {
      setSavingToDrive(false);
    }
  }

  const { data: result } = useQuery<{ url: string }>({
    queryKey: ['job-result', job.id],
    queryFn: () => api.get(`/v1/jobs/${job.id}/result`),
    enabled: isCompleted,
    staleTime: 55 * 60 * 1000,
  });

  // Thumbnail for card display — smaller file, faster grid load.
  // Falls back to full result URL on API side if thumbnail not yet generated.
  const { data: thumb } = useQuery<{ url: string }>({
    queryKey: ['job-thumb', job.id],
    queryFn: () => api.get(`/v1/jobs/${job.id}/thumbnail`),
    enabled: isCompleted,
    staleTime: 55 * 60 * 1000,
  });

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.del(`/v1/jobs/${job.id}`);
      qc.setQueryData<CatalogueDetail>(['catalogue', catalogueId], (old) =>
        old ? { ...old, jobs: old.jobs.filter((j) => j.id !== job.id) } : old,
      );
      qc.invalidateQueries({ queryKey: ['catalogues'] });
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Failed to delete image.');
      setDeleting(false);
    }
  }

  const cardBg = isCompleted ? C.lighter : C.dark;

  const stageLabel =
    job.status === 'PENDING_MANNEQUIN'
      ? 'Preparing garment…'
      : job.status === 'PREPROCESSING'
        ? 'Preparing…'
        : job.status === 'UPLOADING'
          ? 'Saving…'
          : 'Generating…';

  return (
    <>
      <div
        className="prod-card"
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          border: `1px solid ${C.border}`,
          borderRadius: 14,
          overflow: 'hidden',
          background: C.card,
        }}
      >
        <div>
          <button
            type="button"
            disabled={!(isCompleted && result?.url)}
            style={{
              width: '100%',
              aspectRatio: '3/4',
              background: cardBg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              overflow: 'hidden',
              cursor: isCompleted && result?.url ? 'pointer' : 'default',
              border: 'none',
              padding: 0,
            }}
            onClick={() => {
              // Always zoom into full-resolution image even when card shows thumbnail
              if (isCompleted && result?.url) onZoom({ url: result.url, job });
            }}
          >
            {/* Garment preview as blurred background for in-progress states */}
            {!isCompleted && !isFailed && garmentUrl && (
              <>
                {/* biome-ignore lint/performance/noImgElement: presigned R2 URL */}
                <img
                  src={garmentUrl}
                  alt=""
                  aria-hidden="true"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    objectPosition: 'center top',
                    filter: 'blur(2px) brightness(0.35)',
                    transform: 'scale(1.05)',
                  }}
                />
              </>
            )}
            {isCompleted && (thumb?.url ?? result?.url) ? (
              // eslint-disable-next-line @next/next/no-img-element
              // biome-ignore lint/performance/noImgElement: presigned R2 URL, Next/Image incompatible
              <img
                src={thumb?.url ?? result?.url}
                alt={`Generated look — job ${job.id.slice(0, 8)}`}
                width={768}
                height={1024}
                loading="lazy"
                draggable={false}
                onContextMenu={(e) => e.preventDefault()}
                onError={(e) => {
                  // Presigned URL expired — invalidate so next render re-fetches
                  e.currentTarget.style.display = 'none';
                  qc.invalidateQueries({ queryKey: ['job-result', job.id] });
                  qc.invalidateQueries({ queryKey: ['job-thumb', job.id] });
                }}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  objectPosition: 'top center',
                  WebkitTouchCallout: 'none',
                  WebkitUserSelect: 'none',
                  userSelect: 'none',
                }}
              />
            ) : (
              // Overlay sits above the absolute-positioned garment bg image
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {isFailed ? (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 8,
                      color: '#F55C7A',
                    }}
                  >
                    <XIcon size={22} />
                    <span style={{ fontSize: 12, color: 'rgba(245,92,122,0.8)' }}>
                      Generation failed
                    </span>
                  </div>
                ) : isQueued ? (
                  // ── Queue position state ──
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 8,
                      padding: '0 20px',
                      textAlign: 'center',
                      width: '100%',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        color: C.white,
                        letterSpacing: '-0.01em',
                      }}
                    >
                      {ordinal(queuePosition)} in Queue
                    </span>
                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', lineHeight: 1.4 }}>
                      {queuePosition === 1
                        ? 'Starting soon…'
                        : `Starts in ~${queuePosition * 2} mins`}
                    </span>
                    {/* Shimmer bar */}
                    <div
                      style={{
                        width: '72%',
                        height: 3,
                        borderRadius: 2,
                        background: 'rgba(255,255,255,0.1)',
                        overflow: 'hidden',
                        marginTop: 6,
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: '40%',
                          borderRadius: 2,
                          background: 'linear-gradient(90deg,#F55C7A,#F6B553)',
                          animation: 'cardShimmer 1.8s ease-in-out infinite',
                        }}
                      />
                    </div>
                  </div>
                ) : isActive ? (
                  // ── Active generation state (PREPROCESSING / GENERATING / UPLOADING) ──
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 10,
                      padding: '0 16px',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ position: 'relative', width: 56, height: 56 }}>
                      <ProgressRing pct={pct} />
                      <span
                        style={{
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 10,
                          fontWeight: 700,
                          color: C.white,
                        }}
                      >
                        {pct}%
                      </span>
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: C.white }}>
                      {stageLabel}
                    </span>
                    <span
                      style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', lineHeight: 1.4 }}
                    >
                      This may take a few minutes
                    </span>
                  </div>
                ) : null}
              </div>
            )}

            {/* Watermark Banner — reflects what was actually delivered (assetKind),
                not the creation-time entitlement snapshot (job.watermark), so a
                kill-switch override during processing never shows a false banner. */}
            {isCompleted && job.assetKind === 'WATERMARKED' && (
              <div
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  background: 'rgba(0,0,0,0.6)',
                  color: 'white',
                  fontSize: 10,
                  fontWeight: 600,
                  textAlign: 'center',
                  padding: '4px 0',
                  backdropFilter: 'blur(4px)',
                }}
              >
                Watermarked - Upgrade to remove
              </div>
            )}
          </button>
        </div>
        <div
          style={{
            padding: '8px 10px',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: isCompleted ? 'var(--c-mint)' : isFailed ? C.pink : 'var(--c-amber)',
                background: isCompleted
                  ? 'rgba(32,158,70,0.1)'
                  : isFailed
                    ? 'rgba(245,92,122,0.1)'
                    : 'rgba(246,181,83,0.1)',
                padding: '2px 7px',
                borderRadius: 20,
              }}
            >
              {isCompleted
                ? 'Ready'
                : isFailed
                  ? 'Failed'
                  : isQueued
                    ? 'Queued'
                    : job.status === 'PENDING_MANNEQUIN'
                      ? 'Preparing'
                      : 'Generating'}
            </span>
            <span style={{ fontSize: 11, color: C.light }}>
              {new Date(job.createdAt).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
              })}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
            {TERMINAL.includes(job.status) && (
              <button
                type="button"
                onClick={() => {
                  setDeleteError(null);
                  setConfirmOpen(true);
                }}
                disabled={deleting}
                aria-label="Delete image"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: C.pink,
                  display: 'flex',
                  padding: 2,
                  opacity: deleting ? 0.5 : 1,
                }}
                title="Delete"
              >
                {deleting ? <SpinnerIcon size={14} /> : <TrashIcon />}
              </button>
            )}
            {isCompleted && result?.url && (
              <>
                <button
                  type="button"
                  onClick={() => onZoom({ url: result.url, job })}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: C.lighter,
                    border: 'none',
                    cursor: 'pointer',
                    color: C.mid,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                  }}
                >
                  <FullscreenIcon />
                </button>
                <button
                  type="button"
                  disabled={downloading}
                  title="Download"
                  onClick={async () => {
                    if (downloading) return;
                    setDownloading(true);
                    try {
                      // Real download signal — POST /download (not the cached result.url)
                      // both refreshes the presigned URL and stamps downloadedAt
                      // server-side, which disables this job's regenerate option.
                      const { url } = await api.post<{ url: string }>(
                        `/v1/jobs/${job.id}/download`,
                        {},
                      );
                      const res = await fetch(url);
                      if (!res.ok) throw new Error(downloadErrorMessage(res.status));
                      const blob = await res.blob();
                      const objectUrl = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = objectUrl;
                      a.download = `tryme-${job.id.slice(0, 8)}.jpg`;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(objectUrl);
                      qc.invalidateQueries({ queryKey: ['catalogue', catalogueId] });
                    } catch (e) {
                      alert(
                        e instanceof Error
                          ? e.message
                          : 'The image could not be downloaded. Try again.',
                      );
                    } finally {
                      setDownloading(false);
                    }
                  }}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: downloading
                      ? C.border
                      : 'linear-gradient(91.84deg, #521D9C 0.33%, #BD2587 50.77%, #F96657 99.67%)',
                    cursor: downloading ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: C.white,
                    border: 'none',
                    padding: 0,
                  }}
                >
                  {downloading ? <SpinnerIcon size={14} /> : <DownloadIcon size={16} />}
                </button>
                {REGENERATE_ENABLED && !job.alreadyDownloaded && (
                  <button
                    type="button"
                    onClick={() => onRegenerate(job.id)}
                    title="Regenerate"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      height: 28,
                      padding: '0 10px',
                      borderRadius: 8,
                      background: 'linear-gradient(135deg, var(--c-pink), var(--c-amber))',
                      color: '#fff',
                      border: 'none',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Regenerate
                  </button>
                )}
                {GOOGLE_DRIVE_ENABLED && (
                  <button
                    type="button"
                    disabled={savingToDrive}
                    title="Save to Drive"
                    onClick={saveToDrive}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 8,
                      background: savingToDrive ? C.border : C.lighter,
                      cursor: savingToDrive ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: C.mid,
                      border: 'none',
                      padding: 0,
                    }}
                  >
                    {savingToDrive ? <SpinnerIcon size={14} /> : <DriveIcon size={16} />}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="Delete this image?"
        message="This cannot be undone."
        confirmLabel="Delete"
        danger
        busy={deleting}
        error={deleteError}
        onConfirm={handleDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

export default function CataloguePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.ReactElement {
  const { id } = use(params);
  const qc = useQueryClient();
  const [zoom, setZoom] = useState<{ url: string; job: Job } | null>(null);
  const [zoomVisible, setZoomVisible] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);
  const driveStatus = useGoogleDriveStatus();
  const [savingAllToDrive, setSavingAllToDrive] = useState(false);
  const [driveProgress, setDriveProgress] = useState<{ done: number; total: number } | null>(null);
  const [driveErr, setDriveErr] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const regeneratingRef = useRef(false);
  const [reasonModalJobId, setReasonModalJobId] = useState<string | null>(null);
  const [regenerateReason, setRegenerateReason] = useState('');
  const [showRegenerateLimitModal, setShowRegenerateLimitModal] = useState(false);
  // Reasons configured on the job's workflow, fetched fresh each time the
  // modal opens — always ends with a fixed "Other" the client appends itself.
  const [reasonOptions, setReasonOptions] = useState<string[]>([]);
  const zoomDialogRef = useRef<HTMLDivElement>(null);
  const zoomTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (zoom) {
      zoomTriggerRef.current = document.activeElement as HTMLElement;
      requestAnimationFrame(() => setZoomVisible(true));
    } else {
      setZoomVisible(false);
      zoomTriggerRef.current?.focus();
    }
  }, [zoom]);

  // Focus trap for zoom lightbox
  useEffect(() => {
    if (!zoom) return;
    const el = zoomDialogRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => document.removeEventListener('keydown', trap);
  }, [zoom]);

  useEffect(() => {
    if (!downloadErr) return;
    const t = setTimeout(() => setDownloadErr(null), 3500);
    return () => clearTimeout(t);
  }, [downloadErr]);

  useEffect(() => {
    if (!driveErr) return;
    const t = setTimeout(() => setDriveErr(null), 3500);
    return () => clearTimeout(t);
  }, [driveErr]);

  const { data, isLoading } = useQuery<CatalogueDetail>({
    queryKey: ['catalogue', id],
    queryFn: () => api.get(`/v1/catalogues/${id}`),
    // Poll every 5s while any job is still active; fall back to 5-min interval
    // once all are terminal. Real-time updates also come from useJobStream below.
    refetchInterval: (query) => {
      const d = query.state.data as CatalogueDetail | undefined;
      if (!d) return false;
      const hasActive = d.jobs.some((j) => !TERMINAL.includes(j.status));
      return hasActive ? 5_000 : 5 * 60 * 1000;
    },
    // Override providers.tsx's global refetchOnWindowFocus:false /
    // refetchIntervalInBackground default (also false) for this query only, so
    // this poll — the fallback for a dropped SSE event — keeps running while the
    // tab is backgrounded and catches up immediately on refocus.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  useJobStream(
    useCallback(
      (evt) => {
        qc.setQueryData<CatalogueDetail>(['catalogue', id], (old) => {
          if (!old) return old;
          const belongs = old.jobs.some((j) => j.id === evt.jobId);
          if (!belongs) return old;
          return {
            ...old,
            jobs: old.jobs.map((j) => (j.id === evt.jobId ? { ...j, status: evt.status } : j)),
          };
        });

        if (evt.status === 'COMPLETED') {
          // Eagerly prime both caches so ImageCard renders immediately
          qc.prefetchQuery({
            queryKey: ['job-result', evt.jobId],
            queryFn: () => api.get<{ url: string }>(`/v1/jobs/${evt.jobId}/result`),
            staleTime: 55 * 60 * 1000,
          });
          qc.prefetchQuery({
            queryKey: ['job-thumb', evt.jobId],
            queryFn: () => api.get<{ url: string }>(`/v1/jobs/${evt.jobId}/thumbnail`),
            staleTime: 55 * 60 * 1000,
          });
        }
      },
      [id, qc],
    ),
  );

  // A regenerate creates a new job pointing back via parentJobId rather than
  // mutating the original — every count/list/action below should treat the
  // superseded parent as gone, not as a second copy of the same look.
  const visibleJobs = useMemo(() => {
    const all = data?.jobs ?? [];
    return all.filter((job) => !all.some((other) => other.parentJobId === job.id));
  }, [data?.jobs]);

  // Ordered queue positions — oldest QUEUED job = position 1
  const queuedIds = useMemo(
    () =>
      visibleJobs
        .filter((j) => j.status === 'QUEUED')
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .map((j) => j.id),
    [visibleJobs],
  );

  const completedCount = visibleJobs.filter((j) => j.status === 'COMPLETED').length;
  const total = visibleJobs.length;

  async function handleDownloadAll() {
    if (!data || downloading) return;
    const completed = visibleJobs.filter((j) => j.status === 'COMPLETED');
    if (completed.length === 0) return;
    setDownloading(true);
    setDownloadErr(null);

    try {
      // Phase 1: fetch all presigned URLs in parallel (fast API calls, no network to R2).
      // POST /download (not GET /result) is the real download signal — it stamps
      // downloadedAt server-side, which disables each job's regenerate option.
      const urlResults = await Promise.allSettled(
        completed.map((job) =>
          api
            .post<{ url: string; expiresIn: number }>(`/v1/jobs/${job.id}/download`, {})
            .then((res) => ({ jobId: job.id, url: res.url, expiresIn: res.expiresIn })),
        ),
      );

      const phase1Elapsed = 0; // allSettled is near-instant relative to expiresIn
      const validEntries = urlResults
        .filter(
          (r): r is PromiseFulfilledResult<{ jobId: string; url: string; expiresIn: number }> =>
            r.status === 'fulfilled',
        )
        .filter((r) => r.value.expiresIn - phase1Elapsed > 10)
        .map((r) => r.value);

      // Phase 2: fetch blobs with concurrency=5
      const blobResults = await concurrentPool(
        validEntries.map(({ jobId, url }) => async () => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(downloadErrorMessage(res.status));
          const blob = await res.blob();
          return { jobId, blob };
        }),
        5,
      );

      const succeeded = blobResults
        .filter(
          (r): r is PromiseFulfilledResult<{ jobId: string; blob: Blob }> =>
            r.status === 'fulfilled',
        )
        .map((r) => r.value);

      const failures = completed.length - succeeded.length;

      // Trigger individual downloads
      for (const { jobId, blob } of succeeded) {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = `tryme-${jobId.slice(0, 8)}.jpg`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      }

      if (failures > 0) {
        setDownloadErr(
          `${failures} of ${completed.length} image${completed.length !== 1 ? 's' : ''} failed to download.`,
        );
      }
      qc.invalidateQueries({ queryKey: ['catalogue', id] });
    } catch {
      setDownloadErr('Download failed. Please try again.');
    } finally {
      setDownloading(false);
    }
  }

  async function handleSaveAllToDrive() {
    if (!data || savingAllToDrive) return;
    if (driveStatus.data?.status !== 'CONNECTED') {
      window.location.href = '/api/integrations/google-drive/connect';
      return;
    }
    const completed = data.jobs.filter((j) => j.status === 'COMPLETED');
    if (completed.length === 0) return;
    setSavingAllToDrive(true);
    setDriveErr(null);
    setDriveProgress({ done: 0, total: completed.length });
    try {
      const results = await Promise.allSettled(
        completed.map((job) =>
          api.post(`/v1/jobs/${job.id}/export/google-drive`, {}).finally(() => {
            setDriveProgress((p) => (p ? { done: p.done + 1, total: p.total } : p));
          }),
        ),
      );
      const failures = results.filter((r) => r.status === 'rejected').length;
      if (failures > 0) {
        setDriveErr(
          `${failures} of ${completed.length} image${completed.length !== 1 ? 's' : ''} failed to save to Drive.`,
        );
      }
    } finally {
      setSavingAllToDrive(false);
      setDriveProgress(null);
    }
  }

  async function openReasonModal(jobId: string) {
    setReasonModalJobId(jobId);
    setRegenerateReason('');
    setReasonOptions([]);
    try {
      const { reasons } = await api.get<{ reasons: string[] }>(
        `/v1/jobs/${jobId}/regenerate-reasons`,
      );
      setReasonOptions(reasons);
    } catch {
      // No configured reasons is a normal outcome (falls back to "Other" only)
      // — don't block opening the modal over this.
      setReasonOptions([]);
    }
  }

  async function handleRegenerate(jobId: string, reason: string) {
    // Synchronous lock — `regenerating` state alone updates too late to stop a
    // second click landing before the button re-renders as disabled.
    if (regeneratingRef.current) return;
    regeneratingRef.current = true;
    setRegenerating(true);
    // One key per confirmed click, sent as Idempotency-Key: a duplicate/retried
    // request for this exact click reuses the cached result instead of
    // creating (and charging/refunding) a second job.
    const idempotencyKey = crypto.randomUUID();
    try {
      await api.post(
        `/v1/jobs/${jobId}/regenerate`,
        { reason },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      );
      qc.invalidateQueries({ queryKey: ['catalogue', id] });
      setZoom(null);
      setReasonModalJobId(null);
      setRegenerateReason('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'FREE_REGENERATE_LIMIT') {
        setReasonModalJobId(null);
        setRegenerateReason('');
        setShowRegenerateLimitModal(true);
      } else {
        alert((e as Error).message || 'Failed to regenerate. Check if you have enough credits.');
      }
    } finally {
      regeneratingRef.current = false;
      setRegenerating(false);
    }
  }

  return (
    <>
      <style>{`
        @keyframes cardShimmer {
          0%   { transform: translateX(-150%); }
          100% { transform: translateX(400%); }
        }

        .catalogue-detail-wrapper {
          flex: 1;
          overflow-y: auto;
          padding: 24px 28px;
          box-sizing: border-box;
        }

        .catalogue-detail-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 16px;
          width: 100%;
        }

        @media (max-width: 1023px) {
          .catalogue-detail-wrapper {
            padding: 20px 20px;
          }
          .catalogue-detail-grid {
            grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
            gap: 12px;
          }
        }

        @media (max-width: 639px) {
          .catalogue-detail-wrapper {
            padding: 16px 16px;
          }
          .catalogue-detail-grid {
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
          }
        }
      `}</style>
      <TopBar
        lead={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Link
              href="/catalogs"
              style={{ color: C.mid, display: 'flex', textDecoration: 'none' }}
            >
              <ArrowLeft />
            </Link>
            <div>
              <div style={{ fontWeight: 700, fontSize: 18, color: C.text }}>
                Catalog{' '}
                <span style={{ color: C.mid, fontWeight: 500, fontSize: 14 }}>
                  #{id.slice(0, 8)}
                </span>
              </div>
              <div style={{ fontSize: 12, color: C.mid }}>
                {isLoading
                  ? 'Loading…'
                  : `${completedCount} of ${total} image${total !== 1 ? 's' : ''} ready`}
              </div>
            </div>
          </div>
        }
        right={
          <div style={{ display: 'flex', gap: 12 }}>
            <Link
              href={`/catalogs/${id}/preview`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                padding: '0 20px',
                height: 38,
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: C.field,
                color: C.mid,
                fontFamily: 'inherit',
                fontSize: 14,
                fontWeight: 500,
                boxSizing: 'border-box',
                textDecoration: 'none',
              }}
            >
              <MonitorPlayIcon size={18} /> Preview
            </Link>
            <button
              type="button"
              onClick={handleDownloadAll}
              disabled={downloading || completedCount === 0}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '0 20px',
                height: 38,
                borderRadius: 8,
                border: 'none',
                background: C.dark,
                color: C.onDark,
                fontFamily: 'inherit',
                fontSize: 14,
                fontWeight: 600,
                cursor: downloading || completedCount === 0 ? 'not-allowed' : 'pointer',
                opacity: downloading || completedCount === 0 ? 0.5 : 1,
                boxSizing: 'border-box',
                whiteSpace: 'nowrap',
              }}
            >
              {downloading ? (
                <>
                  <SpinnerIcon size={18} /> Downloading…
                </>
              ) : (
                <>
                  Download All <ImageDownIcon size={20} />
                </>
              )}
            </button>
            {GOOGLE_DRIVE_ENABLED && (
              <button
                type="button"
                onClick={handleSaveAllToDrive}
                disabled={savingAllToDrive || completedCount === 0}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '0 20px',
                  height: 38,
                  borderRadius: 8,
                  border: `1px solid ${C.border}`,
                  background: C.field,
                  color: C.mid,
                  fontFamily: 'inherit',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: savingAllToDrive || completedCount === 0 ? 'not-allowed' : 'pointer',
                  opacity: savingAllToDrive || completedCount === 0 ? 0.5 : 1,
                  boxSizing: 'border-box',
                  whiteSpace: 'nowrap',
                }}
              >
                {savingAllToDrive ? (
                  <>
                    <SpinnerIcon size={18} />
                    {driveProgress
                      ? `Saving ${driveProgress.done}/${driveProgress.total}…`
                      : 'Saving…'}
                  </>
                ) : (
                  <>
                    Save All to Drive <DriveIcon size={20} />
                  </>
                )}
              </button>
            )}
          </div>
        }
      />
      <div className="catalogue-detail-wrapper">
        {isLoading && (
          <div
            style={{ display: 'flex', justifyContent: 'center', padding: '64px 0', color: C.mid }}
          >
            <SpinnerIcon />
          </div>
        )}
        {data && (
          <div className="catalogue-detail-grid">
            {visibleJobs.map((job) => (
              <ImageCard
                key={job.id}
                job={job}
                catalogueId={id}
                queuePosition={queuedIds.indexOf(job.id) + 1}
                garmentUrl={data.garmentUrl}
                onZoom={setZoom}
                onRegenerate={openReasonModal}
              />
            ))}
          </div>
        )}
      </div>

      {zoom && (
        <div
          ref={zoomDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onClick={() => setZoom(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setZoom(null);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 40,
          }}
        >
          <button
            type="button"
            onClick={() => setZoom(null)}
            style={{
              position: 'absolute',
              top: 20,
              right: 20,
              width: 40,
              height: 40,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.15)',
              border: 'none',
              color: C.white,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <XIcon size={20} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {/* biome-ignore lint/performance/noImgElement: presigned R2 URL, Next/Image incompatible */}
          <img
            src={zoom.url}
            alt=""
            draggable={false}
            onContextMenu={(e) => e.preventDefault()}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              borderRadius: 8,
              transform: zoomVisible ? 'translateX(0)' : 'translateX(100%)',
              transition: 'transform 300ms ease-out',
              pointerEvents: 'none',
              WebkitTouchCallout: 'none',
              WebkitUserSelect: 'none',
              userSelect: 'none',
            }}
          />
          {REGENERATE_ENABLED && zoom.job.status === 'COMPLETED' && !zoom.job.alreadyDownloaded && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openReasonModal(zoom.job.id);
              }}
              disabled={regenerating}
              style={{
                position: 'absolute',
                bottom: 40,
                padding: '12px 24px',
                borderRadius: 8,
                background: 'linear-gradient(135deg, var(--c-pink), var(--c-amber))',
                color: 'white',
                border: 'none',
                fontWeight: 600,
                fontSize: 14,
                cursor: regenerating ? 'not-allowed' : 'pointer',
                opacity: regenerating ? 0.7 : 1,
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {regenerating ? <SpinnerIcon size={16} /> : null}
              Regenerate
            </button>
          )}
        </div>
      )}

      {REGENERATE_ENABLED && reasonModalJobId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Regenerate reason"
          onClick={() => !regenerating && setReasonModalJobId(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            zIndex: 1100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(420px, 100%)',
              background: C.card,
              borderRadius: 14,
              padding: 24,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: C.text }}>
              Why regenerate this image?
            </h3>
            <p style={{ margin: 0, fontSize: 12.5, color: C.light, lineHeight: 1.5 }}>
              You get {FREE_REGENERATE_DAILY_LIMIT} free regenerations a day. Once this image is
              downloaded it can no longer be regenerated.
            </p>
            <select
              value={regenerateReason}
              onChange={(e) => setRegenerateReason(e.target.value)}
              disabled={regenerating}
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: C.field,
                color: C.text,
                fontSize: 13,
              }}
            >
              <option value="">Select a reason…</option>
              {reasonOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setReasonModalJobId(null)}
                disabled={regenerating}
                style={{
                  padding: '10px 18px',
                  borderRadius: 8,
                  background: 'transparent',
                  color: C.light,
                  border: `1px solid ${C.border}`,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={regenerating || !regenerateReason}
                onClick={() => handleRegenerate(reasonModalJobId, regenerateReason)}
                style={{
                  padding: '10px 18px',
                  borderRadius: 8,
                  background: 'linear-gradient(135deg, var(--c-pink), var(--c-amber))',
                  color: 'white',
                  border: 'none',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: regenerating || !regenerateReason ? 'not-allowed' : 'pointer',
                  opacity: regenerating || !regenerateReason ? 0.6 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {regenerating ? <SpinnerIcon size={16} /> : null}
                Regenerate
              </button>
            </div>
          </div>
        </div>
      )}

      {REGENERATE_ENABLED && showRegenerateLimitModal && (
        <SupportModal
          initialMessage={REGENERATE_LIMIT_SUPPORT_MESSAGE}
          onClose={() => setShowRegenerateLimitModal(false)}
        />
      )}

      {downloadErr && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: C.dark,
            color: C.white,
            padding: '10px 20px',
            borderRadius: 8,
            fontSize: 13,
            zIndex: 1200,
            boxShadow: '0 6px 24px rgba(0,0,0,0.2)',
          }}
        >
          {downloadErr}
        </div>
      )}

      {driveErr && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: C.dark,
            color: C.white,
            padding: '10px 20px',
            borderRadius: 8,
            fontSize: 13,
            zIndex: 1200,
            boxShadow: '0 6px 24px rgba(0,0,0,0.2)',
          }}
        >
          {driveErr}
        </div>
      )}
    </>
  );
}
