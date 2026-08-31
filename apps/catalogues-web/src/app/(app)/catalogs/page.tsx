'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDaysIcon,
  CheckSquareIcon,
  ChevronDown,
  DownloadIcon,
  GarmentIcon,
  ImagesIcon,
  MinusSquareIcon,
  SearchIcon,
  ShoppingBagIcon,
  SpinnerIcon,
  SquareIcon,
  UserRoundIcon,
  XIcon,
} from '@/components/icons';
import { C } from '@/components/tokens';
import { TopBar } from '@/components/topbar';
import { GradBtn } from '@/components/ui/grad-btn';
import { PremiumDateRangePicker } from '@/components/ui/premium-date-range';
import { Tooltip } from '@/components/ui/tooltip';
import { useJobStream } from '@/hooks/use-job-stream';
import { api } from '@/lib/api';
import { downloadErrorMessage } from '@/lib/errors';

// ─── types ────────────────────────────────────────────────────────────────────

interface JobSummary {
  id: string;
  status: string;
  createdAt: string;
  creditsCharged: number;
}
interface Catalogue {
  catalogueId: string;
  jobs: JobSummary[];
  createdAt: string;
  genderSlug: string | null;
  platform: string | null;
  garmentType: string | null;
  coverUrl: string | null;
  coverThumbUrl: string | null;
}

// ─── constants (outside component — stable references) ────────────────────────

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const GENDERS = ['All Segments', 'Women', 'Men', 'Boy', 'Girl'];
const GENDER_MAP: Record<string, string> = {
  Women: 'women',
  Men: 'men',
  Boy: 'boys',
  Girl: 'girls',
};

// ─── concurrency pool (pure utility) ─────────────────────────────────────────

async function concurrentPool<T>(
  fns: Array<() => Promise<T>>,
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  // idx++ is captured synchronously before each await — safe in single-threaded JS
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

// ─── status badge ─────────────────────────────────────────────────────────────

function catalogueStatus(jobs: JobSummary[]): { label: string; color: string } {
  if (jobs.length === 0) return { label: 'Empty', color: 'var(--c-light)' };
  const allCompleted = jobs.every((j) => j.status === 'COMPLETED');
  if (allCompleted) return { label: 'Ready', color: 'var(--c-mint)' };
  const allFailed = jobs.every((j) => j.status === 'FAILED');
  if (allFailed) return { label: 'Failed', color: 'var(--c-pink)' };
  const hasActive = jobs.some((j) => !TERMINAL.includes(j.status));
  if (hasActive) return { label: 'In Progress', color: 'var(--c-amber)' };
  return { label: 'Partial', color: 'var(--c-amber)' };
}

// ─── catalogue cover ──────────────────────────────────────────────────────────

function Cover({
  jobs,
  coverUrl,
  coverThumbUrl,
}: {
  jobs: JobSummary[];
  coverUrl: string | null;
  coverThumbUrl: string | null;
}) {
  const hasActive = jobs.some((j) => !TERMINAL.includes(j.status));
  const allFailed = jobs.length > 0 && jobs.every((j) => j.status === 'FAILED');

  const [imgError, setImgError] = useState(false);
  const displayUrl = imgError ? null : (coverThumbUrl ?? coverUrl);
  if (displayUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      // biome-ignore lint/performance/noImgElement: presigned R2 URL, Next/Image incompatible
      <img
        src={displayUrl}
        alt="Catalog preview"
        width={768}
        height={1024}
        loading="lazy"
        onError={() => setImgError(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top center' }}
      />
    );
  }
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        color: C.mid,
      }}
    >
      {allFailed ? (
        <span style={{ fontSize: 13 }}>Failed</span>
      ) : (
        <>
          <SpinnerIcon />
          <span style={{ fontSize: 13 }}>{hasActive ? 'Generating…' : 'Pending'}</span>
        </>
      )}
    </div>
  );
}

// ─── date grouping ────────────────────────────────────────────────────────────

function groupByDate(items: Catalogue[]): Record<string, Catalogue[]> {
  return items.reduce<Record<string, Catalogue[]>>((acc, cat) => {
    const label = new Date(cat.createdAt).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    if (!acc[label]) acc[label] = [];
    acc[label].push(cat);
    return acc;
  }, {});
}

// ─── date label helper ────────────────────────────────────────────────────────

function dateLabel(filter: string, from: string, to: string): string {
  if (filter !== 'Custom Range' || (!from && !to)) return filter;
  const fmt = (s: string) =>
    new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  if (from && to) return `${fmt(from)} – ${fmt(to)}`;
  if (from) return `From ${fmt(from)}`;
  return `Until ${fmt(to)}`;
}

// ─── page ─────────────────────────────────────────────────────────────────────

function CataloguesPageInner(): React.ReactElement {
  // filter state
  const [search, setSearch] = useState('');
  const [genderFilter, setGenderFilter] = useState('All Segments');
  const [showGenderDropdown, setShowGenderDropdown] = useState(false);
  const [platformFilter, setPlatformFilter] = useState('All Platforms');
  const [showPlatformDropdown, setShowPlatformDropdown] = useState(false);
  const [garmentTypeFilter, setGarmentTypeFilter] = useState('All Garment Types');
  const [showGarmentTypeDropdown, setShowGarmentTypeDropdown] = useState(false);
  const [dateFilter, setDateFilter] = useState('Date');
  const [showDateDropdown, setShowDateDropdown] = useState(false);
  const [dateSubPanel, setDateSubPanel] = useState<'presets' | 'custom'>('presets');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  // draft values — uncommitted until user clicks Apply
  const [pendingFrom, setPendingFrom] = useState('');
  const [pendingTo, setPendingTo] = useState('');

  // selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // download state
  const [downloading, setDownloading] = useState(false);
  const [zipProgress, setZipProgress] = useState<number | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    type: 'success' | 'warning' | 'error';
  } | null>(null);

  // refs
  const genderRef = useRef<HTMLDivElement>(null);
  const platformRef = useRef<HTMLDivElement>(null);
  const garmentTypeRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const filteredRef = useRef<Catalogue[]>([]);
  const downloadingRef = useRef(false);

  const qc = useQueryClient();

  // query
  const { data: catalogues, isLoading } = useQuery<Catalogue[]>({
    queryKey: ['catalogues'],
    queryFn: () => api.get('/v1/catalogues'),
    // Long-interval fallback in case SSE drops. Real-time updates come from useJobStream below.
    refetchInterval: 5 * 60 * 1000,
  });

  const searchParams = useSearchParams();
  const batchId = searchParams.get('batch');

  // Progress-only: per-catalogue total/completed/failed counts for the banner + polling.
  // NOT used to source the card list — /v1/catalogues (below) is capped at 200 rows,
  // so filtering the unfiltered ['catalogues'] cache against this endpoint's catalogueIds
  // silently drops batch catalogues once other job activity fills that window. The
  // batch-scoped query right below fetches the actual cards, unbounded by that cap.
  const batch = useQuery({
    queryKey: ['batch', batchId],
    queryFn: () =>
      api.get<{
        batchId: string;
        totalJobs: number;
        catalogues: Array<{
          catalogueId: string;
          total: number;
          completed: number;
          failed: number;
          createdAt: string;
        }>;
      }>(`/v1/batches/${batchId}`),
    enabled: !!batchId,
    // Poll while anything is still running. The per-user SSE stream also pushes
    // job transitions, but a poll is the simpler correctness floor here.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 4000;
      const done = data.catalogues.every((c) => c.completed + c.failed === c.total);
      return done ? false : 4000;
    },
  });

  // The actual card data for a batch view — scoped server-side via ?batchId, so it's
  // never subject to the general /v1/catalogues 200-row cap.
  const batchCatalogues = useQuery<Catalogue[]>({
    queryKey: ['catalogues', 'batch', batchId],
    queryFn: () => api.get(`/v1/catalogues?batchId=${batchId}`),
    enabled: !!batchId,
    refetchInterval: 5 * 60 * 1000,
  });

  // True only during the batch-scoped catalogues query's first-ever fetch (no cached
  // data yet) — not on background refetch ticks, which already have data. Gates the
  // loading spinner / empty state so a batch view never flashes "No catalogues yet"
  // before the data lands.
  const batchPending = !!batchId && batchCatalogues.isLoading;

  useJobStream(
    useCallback(
      (evt) => {
        // Both the unfiltered list and the batch-scoped list (when a batch view is
        // active) need the same patch — a job can belong to a catalogue that only
        // exists in one of the two caches.
        const cacheKeys = [['catalogues'], ...(batchId ? [['catalogues', 'batch', batchId]] : [])];

        for (const key of cacheKeys) {
          qc.setQueryData<Catalogue[]>(key, (old) => {
            if (!old) return old;
            const updated = old.map((cat) => {
              const jobIdx = cat.jobs.findIndex((j) => j.id === evt.jobId);
              if (jobIdx === -1) return cat;
              const prevStatus = cat.jobs[jobIdx]?.status;
              const updatedJobs = cat.jobs.map((j) =>
                j.id === evt.jobId ? { ...j, status: evt.status } : j,
              );
              const justCompleted = evt.status === 'COMPLETED' && prevStatus !== 'COMPLETED';
              if (justCompleted) {
                // Fetch cover URLs for only this job, then patch only this catalogue in cache.
                // Avoids re-presigning every catalogue's cover on each completion event.
                Promise.all([
                  api.get<{ url: string }>(`/v1/jobs/${evt.jobId}/result`).catch(() => null),
                  api.get<{ url: string }>(`/v1/jobs/${evt.jobId}/thumbnail`).catch(() => null),
                ]).then(([result, thumb]) => {
                  if (!result) return;
                  for (const k of cacheKeys) {
                    qc.setQueryData<Catalogue[]>(k, (prev) => {
                      if (!prev) return prev;
                      return prev.map((c) =>
                        c.catalogueId === cat.catalogueId
                          ? { ...c, coverUrl: result.url, coverThumbUrl: thumb?.url ?? result.url }
                          : c,
                      );
                    });
                  }
                });
              }
              return { ...cat, jobs: updatedJobs };
            });
            return updated;
          });
        }
        // Also keep the detail view in sync if it's mounted.
        // Look up the catalogueId from the list cache so we target the right key.
        const cats = qc.getQueryData<Catalogue[]>(['catalogues']);
        const ownerCat = cats?.find((c) => c.jobs.some((j) => j.id === evt.jobId));
        if (ownerCat) {
          qc.setQueryData<{ catalogueId: string; jobs: { id: string; status: string }[] }>(
            ['catalogue', ownerCat.catalogueId],
            (old) => {
              if (!old) return old;
              return {
                ...old,
                jobs: old.jobs.map((j) => (j.id === evt.jobId ? { ...j, status: evt.status } : j)),
              };
            },
          );
        }
      },
      [qc, batchId],
    ),
  );

  // ── derived state ────────────────────────────────────────────────────────────

  // In a batch view, the batch-scoped query is the source of truth for cards — the
  // unfiltered ['catalogues'] list is capped at 200 rows and can be missing this
  // batch's older catalogues entirely (see the batchCatalogues query above).
  const catalogueSource = batchId ? (batchCatalogues.data ?? []) : (catalogues ?? []);

  // Garment types are admin-curated and numerous (unlike the fixed GENDERS/platform
  // lists) — build the option list from whatever actually appears in the loaded
  // catalogues, rather than hardcoding one.
  const garmentTypeOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const c of catalogueSource) {
      if (c.garmentType) seen.add(c.garmentType);
    }
    return ['All Garment Types', ...Array.from(seen).sort()];
  }, [catalogueSource]);

  // Studio's publishing-platform list (BRAND_CONFIG in studio/page.tsx) has grown
  // over time (AJIO, Nykaa Fashion added later) and a hardcoded list here silently
  // drifted out of sync, making those platforms' catalogues unfilterable. Derive
  // from what's actually present instead, same as garmentTypeOptions above.
  // 'Other' covers jobs submitted without a platform (e.g. Amazon lifestyle mode).
  const platformOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const c of catalogueSource) {
      seen.add(c.platform ?? 'Other');
    }
    return ['All Platforms', ...Array.from(seen).sort()];
  }, [catalogueSource]);

  const filtered = useMemo(() => {
    return catalogueSource.filter((c) => {
      if (!c.catalogueId.toLowerCase().includes(search.toLowerCase())) return false;

      if (genderFilter !== 'All Segments') {
        const expected = GENDER_MAP[genderFilter];
        if (c.genderSlug !== expected) return false;
      }

      if (platformFilter !== 'All Platforms') {
        if ((c.platform ?? 'Other') !== platformFilter) return false;
      }

      if (garmentTypeFilter !== 'All Garment Types') {
        if (c.garmentType !== garmentTypeFilter) return false;
      }

      const created = new Date(c.createdAt);
      const now = new Date();

      if (dateFilter === 'Today') {
        return (
          created.getFullYear() === now.getFullYear() &&
          created.getMonth() === now.getMonth() &&
          created.getDate() === now.getDate()
        );
      }
      if (dateFilter === 'Last 7 Days') {
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - 7);
        return created >= cutoff;
      }
      if (dateFilter === 'Last 15 Days') {
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - 15);
        return created >= cutoff;
      }
      if (dateFilter === 'Last 30 Days') {
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - 30);
        return created >= cutoff;
      }
      if (dateFilter === 'Custom Range') {
        if (customFrom) {
          const from = new Date(customFrom);
          from.setHours(0, 0, 0, 0);
          if (created < from) return false;
        }
        if (customTo) {
          const to = new Date(customTo);
          to.setHours(23, 59, 59, 999);
          if (created > to) return false;
        }
      }

      return true;
    });
  }, [
    catalogueSource,
    search,
    genderFilter,
    platformFilter,
    garmentTypeFilter,
    dateFilter,
    customFrom,
    customTo,
  ]);

  // downloadable = selected catalogues that have at least one COMPLETED job
  const downloadableCatalogues = useMemo(
    () =>
      catalogueSource.filter(
        (c) => selected.has(c.catalogueId) && c.jobs.some((j) => j.status === 'COMPLETED'),
      ),
    [catalogueSource, selected],
  );

  const isSelectionMode = selected.size > 0;
  const canDownload = downloadableCatalogues.length > 0 && !downloading;
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((c) => selected.has(c.catalogueId));
  const someVisibleSelected = filtered.some((c) => selected.has(c.catalogueId));
  const isPartial = someVisibleSelected && !allVisibleSelected;

  const groups = groupByDate(filtered);

  // ── sync refs ────────────────────────────────────────────────────────────────

  filteredRef.current = filtered;
  downloadingRef.current = downloading;

  // ── effects ──────────────────────────────────────────────────────────────────

  // click-outside to close dropdowns
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (genderRef.current && !genderRef.current.contains(e.target as Node))
        setShowGenderDropdown(false);
      if (platformRef.current && !platformRef.current.contains(e.target as Node))
        setShowPlatformDropdown(false);
      if (garmentTypeRef.current && !garmentTypeRef.current.contains(e.target as Node))
        setShowGarmentTypeDropdown(false);
      if (dateRef.current && !dateRef.current.contains(e.target as Node)) {
        setShowDateDropdown(false);
        setDateSubPanel('presets');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // keyboard: Escape = clear selection, Ctrl/Cmd+A = select all visible
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement | null)?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (downloadingRef.current) return;

      if (e.key === 'Escape') {
        setSelected(new Set());
        setLastSelectedId(null);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        setSelected((prev) => new Set([...prev, ...filteredRef.current.map((c) => c.catalogueId)]));
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []); // stable: reads current values via refs

  // abort on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ── selection handlers ───────────────────────────────────────────────────────

  function toggleCard(catalogueId: string, shiftKey: boolean) {
    if (shiftKey && lastSelectedId !== null) {
      const visibleIds = filteredRef.current.map((c) => c.catalogueId);
      const lastIdx = visibleIds.indexOf(lastSelectedId);
      const currentIdx = visibleIds.indexOf(catalogueId);
      if (lastIdx !== -1 && currentIdx !== -1) {
        const from = Math.min(lastIdx, currentIdx);
        const to = Math.max(lastIdx, currentIdx);
        const range = visibleIds.slice(from, to + 1);
        setSelected((prev) => new Set([...prev, ...range]));
        setLastSelectedId(catalogueId);
        return;
      }
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(catalogueId)) next.delete(catalogueId);
      else next.add(catalogueId);
      return next;
    });
    setLastSelectedId(catalogueId);
  }

  function handleSelectAll() {
    if (allVisibleSelected) {
      // deselect all visible (additive cross-filter: only removes visible items)
      setSelected((prev) => {
        const next = new Set(prev);
        for (const c of filtered) next.delete(c.catalogueId);
        return next;
      });
    } else {
      // add all visible (additive: keeps cross-filter selections)
      setSelected((prev) => new Set([...prev, ...filtered.map((c) => c.catalogueId)]));
    }
  }

  function clearSelection() {
    setSelected(new Set());
    setLastSelectedId(null);
  }

  // ── download ─────────────────────────────────────────────────────────────────

  async function handleDownload() {
    if (!canDownload) return;

    const abort = new AbortController();
    abortRef.current = abort;

    // Freeze snapshot at click time — state/query mutations during download don't affect the ZIP
    const snapshotCatalogues = [...downloadableCatalogues];

    setDownloading(true);
    setZipProgress(0);
    setToast(null);

    try {
      // Phase 1: fetch presigned URLs — abort signal forwarded so cancellation stops API calls too
      const completedJobs = snapshotCatalogues.flatMap((cat) =>
        cat.jobs
          .filter((j) => j.status === 'COMPLETED')
          .map((j) => ({ catalogueId: cat.catalogueId, jobId: j.id })),
      );

      const phase1Start = Date.now();
      const urlResults = await Promise.allSettled(
        completedJobs.map(({ catalogueId, jobId }) =>
          api
            .get<{ url: string; expiresIn: number }>(`/v1/jobs/${jobId}/result`, {
              signal: abort.signal,
            })
            .then((res) => ({ catalogueId, url: res.url, expiresIn: res.expiresIn, jobId })),
        ),
      );

      if (abort.signal.aborted) return;

      const phase1ElapsedSec = (Date.now() - phase1Start) / 1000;
      const validEntries = urlResults
        .filter(
          (
            r,
          ): r is PromiseFulfilledResult<{
            catalogueId: string;
            url: string;
            expiresIn: number;
            jobId: string;
          }> => r.status === 'fulfilled',
        )
        // Drop any URL whose remaining TTL won't cover the blob fetch
        .filter((r) => r.value.expiresIn - phase1ElapsedSec > 10)
        .map((r) => r.value);

      if (validEntries.length === 0) {
        setToast({ message: 'No images could be retrieved.', type: 'error' });
        return;
      }

      // Phase 2: blob fetches with concurrency=5 + abort signal
      const total = validEntries.length;
      let done = 0;

      const blobResults = await concurrentPool(
        validEntries.map(({ catalogueId, url }) => async () => {
          const res = await fetch(url, { signal: abort.signal });
          if (!res.ok) throw new Error(downloadErrorMessage(res.status));
          const blob = await res.blob();
          done++;
          if (!abort.signal.aborted) {
            setZipProgress(Math.max(5, (done / total) * 70));
          }
          return { catalogueId, blob };
        }),
        5,
      );

      if (abort.signal.aborted) return;

      const succeeded = blobResults
        .filter(
          (r): r is PromiseFulfilledResult<{ catalogueId: string; blob: Blob }> =>
            r.status === 'fulfilled',
        )
        .map((r) => r.value);

      if (succeeded.length === 0) {
        setToast({ message: 'Selected catalogues have no downloadable images.', type: 'error' });
        return;
      }

      // Phase 3: build ZIP — UUIDs are filesystem-safe, no sanitization needed
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      const byCat = new Map<string, Array<{ blob: Blob }>>();
      for (const item of succeeded) {
        const existing = byCat.get(item.catalogueId);
        if (!existing) {
          byCat.set(item.catalogueId, [{ blob: item.blob }]);
        } else {
          existing.push({ blob: item.blob });
        }
      }

      for (const [catalogueId, items] of byCat.entries()) {
        const folder = zip.folder(catalogueId.slice(0, 8));
        items.forEach((item, idx) => {
          folder?.file(`image-${idx + 1}.jpg`, item.blob);
        });
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' }, (meta: { percent: number }) => {
        if (!abort.signal.aborted) {
          setZipProgress(70 + meta.percent * 0.3);
        }
      });

      if (abort.signal.aborted) return;

      // Trigger download — delay revoke for Firefox compatibility
      const date = new Date().toISOString().slice(0, 10);
      const objectUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `tryme-catalogues-${date}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 100);

      // Toast
      const totalImages = succeeded.length;
      const totalCats = byCat.size;
      const skipped = total - succeeded.length;
      if (skipped > 0) {
        setToast({
          message: `Downloaded ${totalImages} of ${total} images from ${totalCats} catalogue${totalCats !== 1 ? 's' : ''}. ${skipped} could not be retrieved.`,
          type: 'warning',
        });
      } else {
        setToast({
          message: `Downloaded ${totalImages} image${totalImages !== 1 ? 's' : ''} from ${totalCats} catalogue${totalCats !== 1 ? 's' : ''}.`,
          type: 'success',
        });
        setSelected(new Set());
      }
    } catch (err) {
      // Abort is intentional cancellation — silently exit, no toast
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setToast({ message: 'Download failed. Please try again.', type: 'error' });
    } finally {
      setDownloading(false);
      setZipProgress(null);
      abortRef.current = null;
    }
  }

  // ── render ───────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`
        .catalogues-page-wrapper {
          flex: 1;
          overflow-y: auto;
          padding: 0 28px;
          box-sizing: border-box;
        }

        .catalogues-sticky-toolbar {
          position: sticky;
          top: 0;
          z-index: 20;
          background: ${C.bg};
          box-shadow: 0 1px 0 ${C.border};
          margin: 0 -28px;
          padding: 16px 28px;
          box-sizing: border-box;
        }

        .catalogues-toolbar-flex {
          display: flex;
          width: 100%;
          min-height: 40px;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          box-sizing: border-box;
        }

        .catalogues-search-box {
          position: relative;
          width: 240px;
          flex-shrink: 0;
        }

        .catalogues-filter-group {
          display: flex;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
        }

        .cat-filter-wrapper {
          position: relative;
        }

        .cat-filter-btn {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 0 12px;
          height: 40px;
          border-radius: 8px;
          border: 1px solid ${C.border};
          background: ${C.bg};
          font-family: inherit;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          color: ${C.mid};
          box-sizing: border-box;
          white-space: nowrap;
        }

        .catalogues-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 16px;
          width: 100%;
        }

        @media (max-width: 1199px) {
          .catalogues-page-wrapper {
            padding: 0 20px;
          }

          .catalogues-sticky-toolbar {
            margin: 0 -20px;
            padding: 12px 20px;
          }

          .catalogues-toolbar-flex {
            flex-direction: column;
            align-items: stretch;
            gap: 10px;
            min-height: auto;
          }

          .catalogues-search-box {
            width: 100%;
          }

          .catalogues-filter-group {
            width: 100%;
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
          }

          .cat-filter-wrapper {
            flex: 1 1 140px;
            min-width: 120px;
          }

          .cat-filter-btn {
            width: 100% !important;
          }

          .catalogues-grid {
            grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
            gap: 12px;
          }
        }

        @media (max-width: 639px) {
          .catalogues-page-wrapper {
            padding: 0 16px;
          }

          .catalogues-sticky-toolbar {
            margin: 0 -16px;
            padding: 10px 16px;
          }

          .catalogues-filter-group {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
            width: 100%;
          }

          .cat-filter-wrapper {
            width: 100% !important;
            min-width: 0 !important;
            flex: none !important;
          }

          .cat-filter-btn {
            width: 100% !important;
            height: 38px !important;
            padding: 0 8px !important;
            font-size: 12px !important;
            justify-content: center !important;
          }

          .catalogues-grid {
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
          }
        }
      `}</style>
      <TopBar
        title="Catalogs"
        subtitle="View, manage, and download your previously generated catalog images."
        right={undefined}
      />

      <div className="catalogues-page-wrapper">
        {/* ── sticky toolbar ── */}
        <div className="catalogues-sticky-toolbar">
          <div className="catalogues-toolbar-flex">
            {/* search — always visible */}
            <div className="catalogues-search-box">
              <span
                style={{
                  position: 'absolute',
                  left: 12,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: C.mid,
                }}
              >
                <SearchIcon />
              </span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search Catalogs"
                style={{
                  width: '100%',
                  height: 40,
                  padding: '10px 12px 10px 36px',
                  borderRadius: 8,
                  border: `1px solid ${C.border}`,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  outline: 'none',
                  background: C.lighter,
                  color: C.text,
                }}
              />
            </div>

            {/* right side — transforms in selection mode */}
            {isSelectionMode ? (
              <div className="catalogues-filter-group">
                {/* selection count + clear */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    height: 40,
                    padding: '0 12px',
                    borderRadius: 8,
                    border: `1px solid ${C.border}`,
                    background: C.bg,
                    fontSize: 13,
                    fontWeight: 500,
                    color: C.text,
                  }}
                >
                  <span>{selected.size} selected</span>
                  <Tooltip tip={downloading ? 'Download in progress' : undefined} position="top">
                    <button
                      type="button"
                      onClick={clearSelection}
                      disabled={downloading}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        border: 'none',
                        background: 'none',
                        cursor: downloading ? 'not-allowed' : 'pointer',
                        color: C.mid,
                        padding: 0,
                      }}
                    >
                      <XIcon size={14} />
                    </button>
                  </Tooltip>
                </div>

                {/* select-all (indeterminate-aware) */}
                <Tooltip
                  tip={
                    downloading
                      ? 'Download in progress'
                      : filtered.length === 0
                        ? 'No catalogues to select'
                        : undefined
                  }
                  position="top"
                >
                  <button
                    type="button"
                    onClick={handleSelectAll}
                    disabled={downloading || filtered.length === 0}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '0 14px',
                      height: 40,
                      borderRadius: 8,
                      border: `1px solid ${C.border}`,
                      background: C.bg,
                      fontFamily: 'inherit',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: downloading || filtered.length === 0 ? 'not-allowed' : 'pointer',
                      color: C.mid,
                      opacity: downloading ? 0.5 : 1,
                    }}
                  >
                    {allVisibleSelected ? (
                      <CheckSquareIcon size={16} />
                    ) : isPartial ? (
                      <MinusSquareIcon size={16} />
                    ) : (
                      <SquareIcon size={16} />
                    )}
                    {allVisibleSelected ? 'Deselect All' : 'Select All'}
                  </button>
                </Tooltip>

                {/* download button */}
                <Tooltip
                  tip={
                    downloading
                      ? 'Download in progress'
                      : !canDownload
                        ? 'Select completed catalogues to download'
                        : undefined
                  }
                  position="top"
                >
                  <button
                    type="button"
                    onClick={handleDownload}
                    disabled={!canDownload}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      height: 40,
                      padding: '0 16px',
                      borderRadius: 12,
                      background: C.dark,
                      opacity: canDownload ? 1 : 0.4,
                      border: 'none',
                      cursor: canDownload ? 'pointer' : 'not-allowed',
                      color: C.onDark,
                      fontSize: 13,
                      fontWeight: 500,
                      fontFamily: 'inherit',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {downloading ? <SpinnerIcon size={16} /> : <DownloadIcon size={16} />}
                    {downloading
                      ? zipProgress !== null
                        ? `${Math.round(zipProgress)}%`
                        : 'Preparing…'
                      : `Download (${downloadableCatalogues.length})`}
                  </button>
                </Tooltip>
              </div>
            ) : (
              <div className="catalogues-filter-group">
                {/* gender filter */}
                <div className="cat-filter-wrapper" ref={genderRef}>
                  <button
                    type="button"
                    className="cat-filter-btn"
                    onClick={() => setShowGenderDropdown(!showGenderDropdown)}
                    style={{
                      width: 162,
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <UserRoundIcon size={16} />
                      {genderFilter}
                    </span>
                    <span style={{ display: 'flex' }}>
                      <ChevronDown size={16} />
                    </span>
                  </button>
                  {showGenderDropdown && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 44,
                        left: 0,
                        width: 162,
                        background: C.bg,
                        border: `1px solid ${C.border}`,
                        borderRadius: 8,
                        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                        zIndex: 30,
                        overflow: 'hidden',
                      }}
                    >
                      {GENDERS.map((g) => (
                        <button
                          key={g}
                          type="button"
                          onClick={() => {
                            setGenderFilter(g);
                            setShowGenderDropdown(false);
                          }}
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            padding: '10px 12px',
                            fontSize: 13,
                            fontWeight: 500,
                            color: genderFilter === g ? C.pink : C.mid,
                            cursor: 'pointer',
                            background:
                              genderFilter === g ? 'rgba(245,92,122,0.06)' : 'transparent',
                            border: 'none',
                            fontFamily: 'inherit',
                          }}
                        >
                          {g}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* platform filter */}
                <div className="cat-filter-wrapper" ref={platformRef}>
                  <button
                    type="button"
                    className="cat-filter-btn"
                    onClick={() => setShowPlatformDropdown(!showPlatformDropdown)}
                    style={{
                      width: 158,
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <ShoppingBagIcon size={16} />
                      {platformFilter}
                    </span>
                    <span style={{ display: 'flex' }}>
                      <ChevronDown size={16} />
                    </span>
                  </button>
                  {showPlatformDropdown && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 44,
                        left: 0,
                        width: 158,
                        background: C.bg,
                        border: `1px solid ${C.border}`,
                        borderRadius: 8,
                        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                        zIndex: 30,
                        overflow: 'hidden',
                      }}
                    >
                      {platformOptions.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => {
                            setPlatformFilter(p);
                            setShowPlatformDropdown(false);
                          }}
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            padding: '10px 12px',
                            fontSize: 13,
                            fontWeight: 500,
                            color: platformFilter === p ? C.pink : C.mid,
                            cursor: 'pointer',
                            background:
                              platformFilter === p ? 'rgba(245,92,122,0.06)' : 'transparent',
                            border: 'none',
                            fontFamily: 'inherit',
                          }}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* garment type filter */}
                <div className="cat-filter-wrapper" ref={garmentTypeRef}>
                  <button
                    type="button"
                    className="cat-filter-btn"
                    onClick={() => setShowGarmentTypeDropdown(!showGarmentTypeDropdown)}
                    style={{
                      width: 176,
                    }}
                  >
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <GarmentIcon size={16} />
                      {garmentTypeFilter}
                    </span>
                    <span style={{ display: 'flex', flexShrink: 0 }}>
                      <ChevronDown size={16} />
                    </span>
                  </button>
                  {showGarmentTypeDropdown && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 44,
                        left: 0,
                        width: 176,
                        maxHeight: 320,
                        overflowY: 'auto',
                        background: C.bg,
                        border: `1px solid ${C.border}`,
                        borderRadius: 8,
                        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                        zIndex: 30,
                      }}
                    >
                      {garmentTypeOptions.map((g) => (
                        <button
                          key={g}
                          type="button"
                          onClick={() => {
                            setGarmentTypeFilter(g);
                            setShowGarmentTypeDropdown(false);
                          }}
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            padding: '10px 12px',
                            fontSize: 13,
                            fontWeight: 500,
                            color: garmentTypeFilter === g ? C.pink : C.mid,
                            cursor: 'pointer',
                            background:
                              garmentTypeFilter === g ? 'rgba(245,92,122,0.06)' : 'transparent',
                            border: 'none',
                            fontFamily: 'inherit',
                          }}
                        >
                          {g}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* date filter */}
                <div className="cat-filter-wrapper" ref={dateRef}>
                  <button
                    type="button"
                    className="cat-filter-btn"
                    onClick={() => {
                      if (!showDateDropdown) {
                        setDateSubPanel('presets');
                      }
                      setShowDateDropdown(!showDateDropdown);
                    }}
                    style={{
                      border: `1px solid ${dateFilter !== 'Date' ? C.pink : C.border}`,
                      background: dateFilter !== 'Date' ? 'rgba(245,92,122,0.04)' : C.bg,
                      color: dateFilter !== 'Date' ? C.pink : C.mid,
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <CalendarDaysIcon size={16} />
                      {dateLabel(dateFilter, customFrom, customTo)}
                    </span>
                    <span style={{ display: 'flex' }}>
                      <ChevronDown size={16} />
                    </span>
                  </button>

                  {showDateDropdown && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 44,
                        left: 0,
                        width: dateSubPanel === 'custom' ? 296 : 220,
                        background: C.bg,
                        border: `1px solid ${C.border}`,
                        borderRadius: 8,
                        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                        zIndex: 30,
                        overflow: 'hidden',
                      }}
                    >
                      {dateSubPanel === 'presets' ? (
                        <>
                          {['Today', 'Last 7 Days', 'Last 15 Days', 'Last 30 Days'].map((d) => (
                            <button
                              key={d}
                              type="button"
                              onClick={() => {
                                setDateFilter(d);
                                setCustomFrom('');
                                setCustomTo('');
                                setShowDateDropdown(false);
                                setDateSubPanel('presets');
                              }}
                              style={{
                                width: '100%',
                                textAlign: 'left',
                                padding: '10px 12px',
                                fontSize: 13,
                                fontWeight: 500,
                                color: dateFilter === d ? C.pink : C.mid,
                                cursor: 'pointer',
                                background:
                                  dateFilter === d ? 'rgba(245,92,122,0.06)' : 'transparent',
                                border: 'none',
                                fontFamily: 'inherit',
                              }}
                            >
                              {d}
                            </button>
                          ))}
                          {/* Custom Range — opens sub-panel, does not close dropdown */}
                          <button
                            type="button"
                            onClick={() => {
                              setPendingFrom(customFrom);
                              setPendingTo(customTo);
                              setDateSubPanel('custom');
                            }}
                            style={{
                              width: '100%',
                              textAlign: 'left',
                              padding: '10px 12px',
                              fontSize: 13,
                              fontWeight: 500,
                              color: dateFilter === 'Custom Range' ? C.pink : C.mid,
                              cursor: 'pointer',
                              background:
                                dateFilter === 'Custom Range'
                                  ? 'rgba(245,92,122,0.06)'
                                  : 'transparent',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              border: 'none',
                              fontFamily: 'inherit',
                            }}
                          >
                            Custom Range
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M9 18l6-6-6-6" />
                            </svg>
                          </button>
                          {/* Clear active filter */}
                          {dateFilter !== 'Date' && (
                            <button
                              type="button"
                              onClick={() => {
                                setDateFilter('Date');
                                setCustomFrom('');
                                setCustomTo('');
                                setShowDateDropdown(false);
                              }}
                              style={{
                                width: '100%',
                                textAlign: 'left',
                                padding: '10px 12px',
                                fontSize: 12,
                                fontWeight: 500,
                                color: C.light,
                                cursor: 'pointer',
                                borderTop: `1px solid ${C.border}`,
                                borderLeft: 'none',
                                borderRight: 'none',
                                borderBottom: 'none',
                                fontFamily: 'inherit',
                                background: 'none',
                              }}
                            >
                              Clear filter
                            </button>
                          )}
                        </>
                      ) : (
                        /* custom range sub-panel */
                        <div style={{ padding: 12 }}>
                          {/* back header */}
                          <button
                            type="button"
                            onClick={() => setDateSubPanel('presets')}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              background: 'none',
                              border: 'none',
                              padding: '0 0 10px',
                              cursor: 'pointer',
                              fontSize: 12,
                              fontWeight: 600,
                              color: C.mid,
                              fontFamily: 'inherit',
                              width: '100%',
                              borderBottom: `1px solid ${C.border}`,
                              marginBottom: 12,
                            }}
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M15 18l-6-6 6-6" />
                            </svg>
                            Custom Range
                          </button>

                          {/* Premium date range picker */}
                          <PremiumDateRangePicker
                            from={pendingFrom}
                            to={pendingTo}
                            onChange={(f, t) => {
                              setPendingFrom(f);
                              setPendingTo(t);
                            }}
                            onClear={() => {
                              setPendingFrom('');
                              setPendingTo('');
                            }}
                            onApply={() => {
                              if (!pendingFrom && !pendingTo) return;
                              setDateFilter('Custom Range');
                              setCustomFrom(pendingFrom);
                              setCustomTo(pendingTo);
                              setShowDateDropdown(false);
                              setDateSubPanel('presets');
                            }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* select all (normal mode) */}
                <div className="cat-filter-wrapper">
                  <Tooltip
                    tip={filtered.length === 0 ? 'No catalogues to select' : undefined}
                    position="top"
                  >
                    <button
                      type="button"
                      className="cat-filter-btn"
                      onClick={handleSelectAll}
                      disabled={filtered.length === 0}
                      style={{
                        width: 118,
                        cursor: filtered.length === 0 ? 'not-allowed' : 'pointer',
                        opacity: filtered.length === 0 ? 0.4 : 1,
                      }}
                    >
                      <SquareIcon size={16} />
                      Select All
                    </button>
                  </Tooltip>
                </div>

                {/* download (inactive in normal mode) */}
                <Tooltip tip="Select images to download" position="top">
                  <button
                    type="button"
                    disabled
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 56,
                      height: 40,
                      padding: '12px 20px',
                      borderRadius: 12,
                      background: C.dark,
                      opacity: 0.4,
                      border: 'none',
                      cursor: 'not-allowed',
                      color: C.onDark,
                      boxSizing: 'border-box',
                    }}
                  >
                    <DownloadIcon size={16} />
                  </button>
                </Tooltip>
              </div>
            )}
          </div>

          {/* download progress bar */}
          {zipProgress !== null && (
            <div
              style={{
                height: 3,
                background: C.border,
                borderRadius: 2,
                overflow: 'hidden',
                marginTop: 10,
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${zipProgress}%`,
                  background: 'linear-gradient(90deg, var(--c-pink), var(--c-amber))',
                  transition: 'width 200ms ease',
                  borderRadius: 2,
                }}
              />
            </div>
          )}
        </div>
        {/* ── end sticky toolbar ── */}

        <div style={{ paddingTop: 20 }}>
          {batchId && batch.data && (
            <div style={{ marginBottom: 16 }}>
              <strong style={{ color: C.text }}>
                Batch — {batch.data.catalogues.length} catalogues, {batch.data.totalJobs} images
              </strong>
              <span style={{ marginLeft: 12, color: C.mid, fontSize: 13 }}>
                {batch.data.catalogues.reduce((n, c) => n + c.completed, 0)} done,{' '}
                {batch.data.catalogues.reduce((n, c) => n + c.failed, 0)} failed
              </span>
            </div>
          )}

          {(isLoading || batchPending) && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                padding: '64px 0',
                color: C.mid,
              }}
            >
              <SpinnerIcon />
            </div>
          )}

          {!isLoading && !batchPending && filtered.length === 0 && (
            <div style={{ textAlign: 'center', padding: '64px 24px', color: C.mid }}>
              {dateFilter !== 'Date' ||
              genderFilter !== 'All Segments' ||
              platformFilter !== 'All Platforms' ||
              garmentTypeFilter !== 'All Garment Types' ||
              search ? (
                <>
                  <p style={{ fontWeight: 700, fontSize: 18, color: C.text, marginBottom: 8 }}>
                    No catalogues match your filters
                  </p>
                  <p style={{ fontSize: 14 }}>Try adjusting the filters or search term.</p>
                </>
              ) : (
                <>
                  <p style={{ fontWeight: 700, fontSize: 18, color: C.text, marginBottom: 8 }}>
                    No catalogues yet
                  </p>
                  <p style={{ fontSize: 14, marginBottom: 24 }}>
                    Generate your first AI catalogue to get started.
                  </p>
                  <Link href="/studio" style={{ textDecoration: 'none', display: 'inline-block' }}>
                    <GradBtn>Get started</GradBtn>
                  </Link>
                </>
              )}
            </div>
          )}

          {Object.entries(groups).map(([date, items]) => (
            <div key={date} style={{ marginBottom: 28 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  height: 20,
                  marginBottom: 16,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: C.mid, whiteSpace: 'nowrap' }}>
                  {date}
                </span>
                <div style={{ flex: 1, height: 1, background: C.border }} />
              </div>

              <div className="catalogues-grid">
                {items.map((cat) => {
                  const isSelected = selected.has(cat.catalogueId);
                  const showCheckbox = isSelectionMode || hoveredId === cat.catalogueId;

                  const { label: statusLabel, color: statusColor } = catalogueStatus(cat.jobs);
                  const cardContent = (
                    <div
                      key={cat.catalogueId}
                      className="prod-card"
                      style={{
                        width: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        border: isSelected ? `2px solid ${C.pink}` : `1px solid ${C.border}`,
                        borderRadius: 14,
                        overflow: 'hidden',
                        background: C.card,
                        pointerEvents: downloading ? 'none' : 'auto',
                      }}
                    >
                      {/* image area */}
                      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover-only side effects; parent Link/button handles navigation */}
                      <div
                        style={{
                          aspectRatio: '3/4',
                          background: C.lighter,
                          position: 'relative',
                          overflow: 'hidden',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={() => {
                          setHoveredId(cat.catalogueId);
                          qc.prefetchQuery({
                            queryKey: ['catalogue', cat.catalogueId],
                            queryFn: () => api.get(`/v1/catalogues/${cat.catalogueId}`),
                          });
                        }}
                        onMouseLeave={() => setHoveredId(null)}
                      >
                        {/* checkbox — button with ARIA semantics */}
                        {showCheckbox && (
                          // biome-ignore lint/a11y/useSemanticElements: styled checkbox button with full ARIA; <input type="checkbox"> conflicts with absolute-positioned overlay design
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={isSelected}
                            aria-label={isSelected ? 'Deselect catalogue' : 'Select catalogue'}
                            onClick={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              toggleCard(cat.catalogueId, e.shiftKey);
                            }}
                            style={{
                              position: 'absolute',
                              top: 8,
                              left: 8,
                              zIndex: 5,
                              width: 20,
                              height: 20,
                              borderRadius: 5,
                              background: isSelected ? C.pink : 'rgba(255,255,255,0.92)',
                              border: `2px solid ${isSelected ? C.pink : 'rgba(0,0,0,0.18)'}`,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
                              flexShrink: 0,
                              padding: 0,
                            }}
                          >
                            {isSelected && (
                              <svg
                                width="10"
                                height="8"
                                viewBox="0 0 10 8"
                                fill="none"
                                aria-hidden="true"
                              >
                                <path
                                  d="M1 4l2.5 2.5L9 1"
                                  stroke="white"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </button>
                        )}

                        {/* selection tint */}
                        {isSelected && (
                          <div
                            style={{
                              position: 'absolute',
                              inset: 0,
                              background: 'rgba(245,92,122,0.07)',
                              zIndex: 1,
                              pointerEvents: 'none',
                            }}
                          />
                        )}

                        <div className="prod-card-img" style={{ width: '100%', height: '100%' }}>
                          <Cover
                            jobs={cat.jobs}
                            coverUrl={cat.coverUrl}
                            coverThumbUrl={cat.coverThumbUrl}
                          />
                        </div>
                      </div>

                      {/* metadata row — status badge + count + date */}
                      <div
                        style={{
                          padding: '10px 14px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: statusColor,
                            background: `color-mix(in srgb, ${statusColor} 12%, transparent)`,
                            padding: '2px 7px',
                            borderRadius: 20,
                            flexShrink: 0,
                          }}
                        >
                          {statusLabel}
                        </span>
                        <span style={{ color: C.mid, display: 'flex', flexShrink: 0 }}>
                          <ImagesIcon size={14} />
                        </span>
                        <span style={{ fontSize: 12, color: C.mid, flexShrink: 0 }}>
                          {cat.jobs.length}
                        </span>
                        <span
                          style={{
                            fontSize: 12,
                            color: C.light,
                            marginLeft: 'auto',
                            flexShrink: 0,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {new Date(cat.createdAt).toLocaleDateString('en-IN', {
                            day: 'numeric',
                            month: 'short',
                          })}
                        </span>
                      </div>
                    </div>
                  );

                  return isSelectionMode ? (
                    <button
                      key={cat.catalogueId}
                      type="button"
                      className="prod-card-wrapper"
                      onClick={(e) => toggleCard(cat.catalogueId, e.shiftKey)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') toggleCard(cat.catalogueId, false);
                      }}
                      style={{
                        cursor: 'pointer',
                        outline: 'none',
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        display: 'block',
                        textAlign: 'left',
                      }}
                    >
                      {cardContent}
                    </button>
                  ) : (
                    <Link
                      key={cat.catalogueId}
                      href={`/catalogs/${cat.catalogueId}`}
                      className="prod-card-wrapper"
                      style={{ textDecoration: 'none', display: 'block', outline: 'none' }}
                    >
                      {cardContent}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── toast ── */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 28,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            background:
              toast.type === 'success' ? C.dark : toast.type === 'warning' ? '#8B5C00' : C.pink,
            color: '#fff',
            padding: '10px 20px',
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 500,
            boxShadow: '0 4px 24px rgba(0,0,0,0.18)',
            maxWidth: 480,
            textAlign: 'center',
            whiteSpace: 'pre-wrap',
          }}
        >
          {toast.message}
        </div>
      )}
    </>
  );
}

// useSearchParams (for ?batch=<id>) requires a Suspense boundary, or Next.js
// fails the production build with a missing-suspense-with-csr-bailout error.
export default function CataloguesPage(): React.ReactElement {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: C.bg }} />}>
      <CataloguesPageInner />
    </Suspense>
  );
}
