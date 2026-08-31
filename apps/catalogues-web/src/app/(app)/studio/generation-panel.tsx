'use client';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  CheckIcon,
  DownloadIcon,
  DriveIcon,
  RegenerateIcon,
  SpinnerIcon,
  XIcon,
} from '@/components/icons';
import { SupportModal } from '@/components/SupportModal';
import { C } from '@/components/tokens';
import { PremiumSelect } from '@/components/ui/premium-select';
import { useGoogleDriveStatus } from '@/hooks/use-google-drive-status';
import { useJobStream } from '@/hooks/use-job-stream';
import { api } from '@/lib/api';
import { ApiError, downloadErrorMessage } from '@/lib/errors';
import { GOOGLE_DRIVE_ENABLED, REGENERATE_ENABLED } from '@/lib/feature-flags';

// Mirrors FREE_REGENERATE_DAILY_LIMIT in apps/api/src/modules/jobs/regenerate.ts —
// display-only copy; the actual cap is enforced server-side.
const FREE_REGENERATE_DAILY_LIMIT = 5;
const REGENERATE_LIMIT_SUPPORT_MESSAGE = `I've used all ${FREE_REGENERATE_DAILY_LIMIT} free regenerations for today and would like help getting more.`;

export interface GenerationJob {
  id: string;
  poseId: string;
  label: string;
  thumbnailUrl: string;
}

export interface GenerationPanelProps {
  catalogueId: string;
  jobs: GenerationJob[];
  garmentPreviewUrl?: string;
  /** Called once when every job in this batch reaches a terminal status. */
  onAllSettled?: () => void;
  onCancel?: () => void;
  /** When provided, completed results show a "Use this image" button instead of/alongside download. */
  onUseImage?: (args: { url: string; jobId: string; poseLabel: string }) => void;
  /** Hides the "View full catalogue →" link — set when this panel is embedded in a context (e.g. an iframe) where navigating away would strand the user. */
  hideCatalogueLink?: boolean;
  /** Hides the "Download All" button and each result tile's download icon. */
  hideDownload?: boolean;
  /** Hides the "Save to Drive" action on each result tile. */
  hideGoogleDrive?: boolean;
  /** Hides the "AI Processing" input/steps/preview block — that walkthrough is Studio-only; embedded contexts (e.g. the Shopify plugin) go straight to the Generated Results grid. */
  hideProcessingPreview?: boolean;
}

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

const STATUS_PROGRESS: Record<string, number> = {
  PENDING_MANNEQUIN: 3,
  QUEUED: 10,
  PREPROCESSING: 30,
  GENERATING: 60,
  UPLOADING: 85,
  COMPLETED: 100,
  FAILED: 100,
  CANCELLED: 100,
};

const steps = [
  { label: 'Removing Background', threshold: 20 },
  { label: 'Detecting Garment', threshold: 40 },
  { label: 'Understanding Fabric', threshold: 60 },
  { label: 'Generating Natural Folds', threshold: 75 },
  { label: 'Matching Body Pose', threshold: 90 },
  { label: 'Studio Lighting & Shadow', threshold: 100 },
];

const PROCESSING_MESSAGES = ['Analyzing garment details', ...steps.map((step) => step.label)];

function getJobStepInfo(status: string) {
  const progress = STATUS_PROGRESS[status] ?? 10;
  const currentStepIndex = steps.findIndex((step) => progress < step.threshold);
  const stepIndex = currentStepIndex === -1 ? steps.length - 1 : currentStepIndex;
  const currentStep = steps[stepIndex] ?? steps[0];
  return {
    progress,
    stepIndex: stepIndex + 1,
    totalSteps: steps.length,
    stepLabel: currentStep?.label ?? 'Generating',
  };
}

export function GenerationPanel({
  catalogueId,
  jobs,
  garmentPreviewUrl,
  onAllSettled,
  onCancel: _onCancel,
  onUseImage,
  hideCatalogueLink,
  hideDownload,
  hideGoogleDrive,
  hideProcessingPreview,
}: GenerationPanelProps) {
  const qc = useQueryClient();
  const [statuses, setStatuses] = useState<Record<string, string>>(() =>
    Object.fromEntries(jobs.map((j) => [j.id, 'QUEUED'])),
  );
  const [selected, setSelected] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [selectedJobs, setSelectedJobs] = useState<string[]>(() => jobs.map((j) => j.id));
  const [favorites, setFavorites] = useState<string[]>([]);
  const [zoomUrl, setZoomUrl] = useState<string | null>(null);
  const [zoomVisible, setZoomVisible] = useState(false);
  const [downloadedJobIds, setDownloadedJobIds] = useState<Set<string>>(new Set());
  const [regenerating, setRegenerating] = useState(false);
  const regeneratingRef = useRef(false);
  const [reasonModalJobId, setReasonModalJobId] = useState<string | null>(null);
  const [regenerateReason, setRegenerateReason] = useState('');
  const [showRegenerateLimitModal, setShowRegenerateLimitModal] = useState(false);
  // Reasons configured on the job's workflow, fetched fresh each time the
  // modal opens — always ends with a fixed "Other" the client appends itself.
  const [reasonOptions, setReasonOptions] = useState<string[]>([]);
  // Same slots as `jobs`, but a regenerated slot's id is swapped to the new
  // job's id in place — this is what drives every status/progress/result
  // lookup below, so a regenerate reactivates all the existing "generating…"
  // UI for that slot instead of silently doing nothing visible.
  const [displayJobs, setDisplayJobs] = useState<GenerationJob[]>(jobs);
  const [activeMessageIndex, setActiveMessageIndex] = useState(0);

  // Reset local status map + selection whenever a new batch of jobs arrives.
  useEffect(() => {
    setStatuses(Object.fromEntries(jobs.map((j) => [j.id, 'QUEUED'])));
    setSelected(0);
    setSelectedJobs(jobs.map((j) => j.id));
    setFavorites([]);
    setDisplayJobs(jobs);
  }, [jobs]);

  const jobIds = displayJobs.map((j) => j.id);
  useJobStream((evt) => {
    if (!jobIds.includes(evt.jobId)) return;
    setStatuses((prev) => ({ ...prev, [evt.jobId]: evt.status }));

    // Keep the catalogue detail cache in sync so navigating to /catalogs/:id
    // shows the correct status immediately without waiting for a re-fetch.
    qc.setQueryData(
      ['catalogue', catalogueId],
      (old: { jobs: { id: string; status: string }[] } | undefined) => {
        if (!old) return old;
        return {
          ...old,
          jobs: old.jobs.map((j) => (j.id === evt.jobId ? { ...j, status: evt.status } : j)),
        };
      },
    );

    if (evt.status === 'COMPLETED') {
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
  });

  // SSE is the primary channel, but a dropped/missed event (reconnect window,
  // tab backgrounded, etc.) can leave a job stuck at a non-terminal status here
  // forever even though it actually finished server-side. Poll as a fallback —
  // same pattern as the catalogue detail page — so this panel can never drift
  // from what /catalogs/:id already shows.
  const { data: polledCatalogue } = useQuery<{ jobs: { id: string; status: string }[] }>({
    queryKey: ['catalogue', catalogueId],
    queryFn: () => api.get(`/v1/catalogues/${catalogueId}`),
    enabled: !!catalogueId,
    refetchInterval: (query) => {
      const d = query.state.data as { jobs: { id: string; status: string }[] } | undefined;
      if (!d) return 5_000;
      const hasActive = d.jobs.some(
        (j) => jobIds.includes(j.id) && !TERMINAL_STATUSES.has(j.status),
      );
      return hasActive ? 5_000 : false;
    },
    // The two options below override providers.tsx's global refetchOnWindowFocus:
    // false / refetchIntervalInBackground default (also false) for this query
    // only. Without them, this poll — the fallback for exactly the case where
    // SSE dropped an event while the tab was backgrounded — silently pauses in
    // that same backgrounded state, so it can't do the one thing it exists for.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!polledCatalogue) return;
    setStatuses((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const j of polledCatalogue.jobs) {
        if (jobIds.includes(j.id) && next[j.id] !== j.status) {
          next[j.id] = j.status;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polledCatalogue]);

  const allSettled =
    displayJobs.length > 0 &&
    displayJobs.every((j) => TERMINAL_STATUSES.has(statuses[j.id] ?? 'QUEUED'));

  // Rotate processing microcopy every 2.5s while active (Section 6)
  useEffect(() => {
    if (allSettled) return;
    const interval = setInterval(() => {
      setActiveMessageIndex((prev) => (prev + 1) % PROCESSING_MESSAGES.length);
    }, 2500);
    return () => clearInterval(interval);
  }, [allSettled]);

  const completedCount = jobs.filter((j) => statuses[j.id] === 'COMPLETED').length;
  const totalCount = jobs.length;

  // Notify the parent once every job in this batch has reached a terminal
  // status, so it can re-enable the Generate button while results still render.
  // A regenerate flips this back to false and then true again once the new
  // job settles — that's deliberate, not a bug: it re-disables Generate for
  // the duration of the regenerate too.
  useEffect(() => {
    if (allSettled) onAllSettled?.();
  }, [allSettled, onAllSettled]);

  const completedIds = displayJobs.filter((j) => statuses[j.id] === 'COMPLETED').map((j) => j.id);
  const resultQueries = useQueries({
    queries: displayJobs.map((j) => ({
      queryKey: ['job-result', j.id],
      queryFn: () => api.get<{ url: string }>(`/v1/jobs/${j.id}/result`),
      enabled: completedIds.includes(j.id),
      staleTime: 55 * 60 * 1000,
    })),
  });

  const current = displayJobs[selected];
  const currentStatus = current ? (statuses[current.id] ?? 'QUEUED') : 'QUEUED';
  const currentCompleted = currentStatus === 'COMPLETED';
  const currentFailed = currentStatus === 'FAILED' || currentStatus === 'CANCELLED';
  const currentResultUrl = resultQueries[selected]?.data?.url;

  async function downloadImage(_url: string, jobId: string) {
    if (downloading) return;
    setDownloading(true);
    try {
      // Real download signal — POST /download (not the cached result url) both
      // refreshes the presigned URL and stamps downloadedAt server-side, which
      // disables this job's regenerate option.
      const { url } = await api.post<{ url: string }>(`/v1/jobs/${jobId}/download`, {});
      const res = await fetch(url);
      if (!res.ok) throw new Error(downloadErrorMessage(res.status));
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `tryme-${jobId.slice(0, 8)}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      setDownloadedJobIds((prev) => new Set(prev).add(jobId));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'The image could not be downloaded. Try again.');
    } finally {
      setDownloading(false);
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
    // regeneratingRef is checked synchronously so a second click landing
    // before React re-renders the disabled button can't slip through —
    // `regenerating` state alone updates too late to catch that race.
    if (regeneratingRef.current) return;
    regeneratingRef.current = true;
    setRegenerating(true);
    // One key per confirmed click, sent as Idempotency-Key: a retried/duplicate
    // request for this exact click reuses the cached result instead of
    // creating (and charging/refunding) a second job.
    const idempotencyKey = crypto.randomUUID();
    try {
      const { jobId: newJobId } = await api.post<{ jobId: string }>(
        `/v1/jobs/${jobId}/regenerate`,
        { reason },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      );
      // Swap this slot to the new job in place — its status starts QUEUED,
      // which reactivates the same "generating…" UI (hero panel, progress bar,
      // grid tile) the original generation used, instead of the old completed
      // image just sitting there with no feedback.
      setDisplayJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, id: newJobId } : j)));
      setStatuses((prev) => {
        const next = { ...prev };
        delete next[jobId];
        next[newJobId] = 'QUEUED';
        return next;
      });
      const renameId = (ids: string[]) => ids.map((x) => (x === jobId ? newJobId : x));
      setSelectedJobs(renameId);
      setFavorites(renameId);
      setDownloadedJobIds((prev) => {
        if (!prev.has(jobId)) return prev;
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
      qc.invalidateQueries({ queryKey: ['catalogue', catalogueId] });
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

  const driveStatus = useGoogleDriveStatus();
  const [exportingToDrive, setExportingToDrive] = useState<string | null>(null);

  async function saveToDrive(jobId: string) {
    if (exportingToDrive) return;
    if (driveStatus.data?.status !== 'CONNECTED') {
      window.location.href = '/api/integrations/google-drive/connect';
      return;
    }
    setExportingToDrive(jobId);
    try {
      await api.post(`/v1/jobs/${jobId}/export/google-drive`, {});
      alert('Image saved to your "AI Vastra" Google Drive folder!');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not save to Google Drive. Try again.');
    } finally {
      setExportingToDrive(null);
    }
  }

  // Calculate overall progress percentage (average of all jobs)
  const totalProgress = displayJobs.reduce((acc, job) => {
    const status = statuses[job.id] ?? 'QUEUED';
    return acc + (STATUS_PROGRESS[status] ?? 10);
  }, 0);
  const progressPercent =
    displayJobs.length > 0 ? Math.round(totalProgress / displayJobs.length) : 0;

  // Toggle selection for a single job
  const handleToggleSelectJob = (id: string) => {
    setSelectedJobs((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // Toggle selection for all jobs
  const handleToggleSelectAll = () => {
    if (selectedJobs.length === displayJobs.length) {
      setSelectedJobs([]);
    } else {
      setSelectedJobs(displayJobs.map((j) => j.id));
    }
  };

  // Download all completed images
  const handleDownloadAll = async () => {
    const completedSelected = displayJobs.filter((j) => statuses[j.id] === 'COMPLETED');
    for (const job of completedSelected) {
      const idx = displayJobs.findIndex((j) => j.id === job.id);
      const url = resultQueries[idx]?.data?.url;
      if (url) {
        await downloadImage(url, job.id);
      }
    }
  };

  // Toggle favorite state
  const toggleFavorite = (id: string) => {
    setFavorites((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, width: '100%' }}>
        {/* ── Block 1: AI Processing (Studio only — see hideProcessingPreview) ── */}
        {!hideProcessingPreview && (
          <div
            style={{
              background: C.card,
              borderRadius: 20,
              border: `1px solid ${C.border}`,
              boxShadow: '0 4px 20px rgba(0,0,0,0.05)',
              padding: 24,
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
              width: '100%',
              boxSizing: 'border-box',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <h3 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: C.text }}>
                  AI Processing
                </h3>
                <span style={{ fontSize: 13, color: C.mid }}>
                  {allSettled ? 'Your images are ready' : PROCESSING_MESSAGES[activeMessageIndex]}
                </span>
              </div>
            </div>

            <div
              style={{
                background:
                  'linear-gradient(180deg, rgba(82, 29, 156, 0.04) 0%, rgba(117, 74, 176, 0.01) 100%)',
                border: `1px solid ${C.border}`,
                borderRadius: 16,
                padding: '24px 20px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                width: '100%',
                boxSizing: 'border-box',
              }}
            >
              {/* Column 1: Input Image */}
              <div
                style={{
                  flex: 1.2,
                  background: 'transparent',
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 12,
                  height: 280,
                  justifyContent: 'space-between',
                  boxSizing: 'border-box',
                }}
              >
                <div
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Input Image</span>
                  <span style={{ fontSize: 11, color: C.light }}>Your uploaded garment</span>
                </div>
                <div
                  style={{
                    width: '100%',
                    flex: 1,
                    borderRadius: 8,
                    overflow: 'hidden',
                    border: `1px solid ${C.border2}`,
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: C.lighter,
                  }}
                >
                  {garmentPreviewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={garmentPreviewUrl}
                      alt="Garment Preview"
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    />
                  ) : (
                    <div style={{ color: C.light, fontSize: 12 }}>No image</div>
                  )}
                </div>
              </div>

              {/* Chevron Separator 1 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 280,
                  position: 'relative',
                  flexShrink: 0,
                }}
              >
                <div style={{ width: 1, height: '100%', background: C.border2 }} />
                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    border: '1px solid rgba(82, 29, 156, 0.2)',
                    background: C.card,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#521D9C',
                    boxShadow: '0 2px 6px rgba(82, 29, 156, 0.08)',
                    fontSize: 12,
                    fontWeight: 'bold',
                    zIndex: 2,
                  }}
                >
                  ›
                </div>
              </div>

              {/* Column 2: Steps Checklist */}
              <div
                style={{
                  flex: 1.6,
                  background: 'transparent',
                  padding: '0 24px',
                  display: 'flex',
                  flexDirection: 'column',
                  height: 280,
                  justifyContent: 'space-between',
                  boxSizing: 'border-box',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span
                    style={{ fontSize: 13, fontWeight: 600, color: C.text, textAlign: 'center' }}
                  >
                    AI Processing
                  </span>
                  <span style={{ fontSize: 11, color: C.light, textAlign: 'center' }}>
                    Generating studio quality images
                  </span>
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    margin: '10px 0',
                    paddingLeft: 12,
                  }}
                >
                  {steps.map((step, idx) => {
                    const isDone = progressPercent >= step.threshold;
                    const isCurrent =
                      progressPercent < step.threshold &&
                      (idx === 0 || progressPercent >= (steps[idx - 1]?.threshold ?? 0));

                    return (
                      <div
                        key={step.label}
                        style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                      >
                        {isDone ? (
                          <div
                            style={{
                              width: 16,
                              height: 16,
                              borderRadius: '50%',
                              background: 'linear-gradient(180deg, #521D9C 0%, #754AB0 100%)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: '#fff',
                              fontSize: 9,
                              fontWeight: 'bold',
                            }}
                          >
                            ✓
                          </div>
                        ) : isCurrent ? (
                          <SpinnerIcon size={16} />
                        ) : (
                          <div
                            style={{
                              width: 16,
                              height: 16,
                              borderRadius: '50%',
                              border: `2px solid ${C.border2}`,
                              boxSizing: 'border-box',
                            }}
                          />
                        )}
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: isCurrent ? 600 : 500,
                            color: isDone ? C.text : isCurrent ? '#521D9C' : C.light,
                          }}
                        >
                          {step.label}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      fontSize: 12,
                      fontWeight: 500,
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ color: C.text, fontWeight: 600 }}>
                        {allSettled
                          ? 'Catalogue Ready'
                          : (steps.find((s) => progressPercent < s.threshold)?.label ??
                            'Studio Lighting & Shadow')}
                      </span>
                      <span style={{ fontSize: 11, color: C.mid }}>
                        {allSettled
                          ? 'All stages completed'
                          : `Stage ${steps.findIndex((s) => progressPercent < s.threshold) === -1 ? steps.length : steps.findIndex((s) => progressPercent < s.threshold) + 1} of ${steps.length}`}
                      </span>
                    </div>
                    <span style={{ color: '#521D9C', fontWeight: 600 }}>{progressPercent}%</span>
                  </div>
                  <div
                    style={{
                      width: '100%',
                      height: 6,
                      background: C.lighter,
                      borderRadius: 3,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${progressPercent}%`,
                        height: '100%',
                        background: 'linear-gradient(90deg, #521D9C 0%, #754AB0 100%)',
                        borderRadius: 3,
                        transition: 'width 0.4s ease-out',
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Chevron Separator 2 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 280,
                  position: 'relative',
                  flexShrink: 0,
                }}
              >
                <div style={{ width: 1, height: '100%', background: C.border2 }} />
                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    border: '1px solid rgba(82, 29, 156, 0.2)',
                    background: C.card,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#521D9C',
                    boxShadow: '0 2px 6px rgba(82, 29, 156, 0.08)',
                    fontSize: 12,
                    fontWeight: 'bold',
                    zIndex: 2,
                  }}
                >
                  ›
                </div>
              </div>

              {/* Column 3: Preview Output */}
              <div
                style={{
                  flex: 1.2,
                  background: 'transparent',
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 12,
                  height: 280,
                  justifyContent: 'space-between',
                  boxSizing: 'border-box',
                }}
              >
                <div
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                    Preview Output
                  </span>
                  <span style={{ fontSize: 11, color: C.light }}>Studio quality result</span>
                </div>
                <div
                  style={{
                    width: '100%',
                    flex: 1,
                    borderRadius: 8,
                    overflow: 'hidden',
                    border: `1px solid ${C.border2}`,
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: C.lighter,
                  }}
                >
                  {currentCompleted && currentResultUrl ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={currentResultUrl}
                        alt="Preview Output"
                        draggable={false}
                        onContextMenu={(e) => e.preventDefault()}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'contain',
                          WebkitTouchCallout: 'none',
                          WebkitUserSelect: 'none',
                          userSelect: 'none',
                        }}
                      />
                      <div
                        style={{
                          position: 'absolute',
                          right: 8,
                          bottom: 8,
                          display: 'flex',
                          gap: 6,
                        }}
                      >
                        {onUseImage && current && (
                          <button
                            type="button"
                            onClick={() =>
                              onUseImage({
                                url: currentResultUrl,
                                jobId: current.id,
                                poseLabel: current.label,
                              })
                            }
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              height: 32,
                              padding: '0 12px',
                              borderRadius: 8,
                              background: 'linear-gradient(135deg, #521D9C 0%, #754AB0 100%)',
                              color: '#fff',
                              border: 'none',
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: 'pointer',
                              boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
                            }}
                          >
                            Use this image
                          </button>
                        )}
                      </div>
                    </>
                  ) : current ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={garmentPreviewUrl || current.thumbnailUrl}
                        alt="Loading Preview"
                        className={
                          !currentFailed && currentStatus !== 'QUEUED'
                            ? 'garment-deblur processing-pulse'
                            : ''
                        }
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          objectPosition: 'top center',
                          filter: currentFailed
                            ? 'grayscale(60%)'
                            : currentStatus === 'QUEUED'
                              ? 'blur(4px)'
                              : undefined,
                          opacity: currentFailed ? 0.4 : 0.65,
                        }}
                      />
                      {!currentFailed && currentStatus !== 'QUEUED' && (
                        <>
                          <div className="scan-line" aria-hidden="true" />
                          <div className="shimmer" aria-hidden="true" />
                        </>
                      )}
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: currentFailed
                            ? 'rgba(43, 20, 78, 0.5)'
                            : 'rgba(43, 20, 78, 0.18)',
                          padding: 16,
                          gap: 8,
                          textAlign: 'center',
                        }}
                      >
                        {currentFailed ? (
                          <>
                            <div
                              style={{
                                width: 36,
                                height: 36,
                                borderRadius: '50%',
                                background:
                                  currentStatus === 'FAILED'
                                    ? 'rgba(239, 68, 68, 0.2)'
                                    : 'rgba(156, 163, 175, 0.2)',
                                border: `1px solid ${
                                  currentStatus === 'FAILED'
                                    ? 'rgba(239, 68, 68, 0.5)'
                                    : 'rgba(156, 163, 175, 0.5)'
                                }`,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: currentStatus === 'FAILED' ? '#EF4444' : '#9CA3AF',
                              }}
                            >
                              <XIcon size={20} color="currentColor" />
                            </div>
                            <span style={{ color: '#fff', fontSize: 12, fontWeight: 600 }}>
                              {currentStatus === 'FAILED'
                                ? 'Generation failed'
                                : 'Generation cancelled'}
                            </span>
                          </>
                        ) : (
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              gap: 6,
                              background: 'rgba(43, 20, 78, 0.62)',
                              backdropFilter: 'blur(8px)',
                              padding: '10px 14px',
                              borderRadius: 10,
                              border: '1px solid rgba(255, 255, 255, 0.15)',
                              maxWidth: '85%',
                            }}
                          >
                            <div style={{ color: '#754AB0' }}>
                              <SpinnerIcon size={20} />
                            </div>
                            <span style={{ color: '#fff', fontSize: 12, fontWeight: 600 }}>
                              {currentStatus === 'QUEUED'
                                ? 'Waiting in queue'
                                : getJobStepInfo(currentStatus).stepLabel}
                            </span>
                            {currentStatus !== 'QUEUED' && (
                              <span style={{ color: 'rgba(255, 255, 255, 0.75)', fontSize: 11 }}>
                                {`Stage ${getJobStepInfo(currentStatus).stepIndex} of ${steps.length} • ${STATUS_PROGRESS[currentStatus] ?? 10}%`}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div style={{ color: C.light, fontSize: 12 }}>Waiting...</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Block 2: Generated Results ── */}
        <div
          style={{
            background: C.card,
            borderRadius: 20,
            border: `1px solid ${C.border}`,
            boxShadow: '0 4px 20px rgba(0,0,0,0.05)',
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
            width: '100%',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h3 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: C.text }}>
                  {allSettled ? 'Generated Results' : 'Generating Results'}
                </h3>
                {!allSettled && (
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: 12,
                      background: 'rgba(82, 29, 156, 0.08)',
                      color: '#521D9C',
                      border: '1px solid rgba(82, 29, 156, 0.2)',
                    }}
                  >
                    {completedCount} of {totalCount} ready
                  </span>
                )}
              </div>
              <span style={{ fontSize: 13, color: C.mid }}>
                {allSettled
                  ? `${displayJobs.length} stunning variations generated for you`
                  : PROCESSING_MESSAGES[activeMessageIndex]}
              </span>
            </div>
            {!hideDownload && (
              <div style={{ display: 'flex', gap: 10 }}>
                {/* Download All Button */}
                <button
                  type="button"
                  onClick={handleDownloadAll}
                  disabled={downloading || displayJobs.every((j) => statuses[j.id] !== 'COMPLETED')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: '#141414',
                    color: '#FEFEFE',
                    border: 'none',
                    borderRadius: 8,
                    padding: '8px 16px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor:
                      downloading || displayJobs.every((j) => statuses[j.id] !== 'COMPLETED')
                        ? 'not-allowed'
                        : 'pointer',
                    opacity:
                      downloading || displayJobs.every((j) => statuses[j.id] !== 'COMPLETED')
                        ? 0.5
                        : 1,
                  }}
                >
                  <DownloadIcon size={14} /> Download All
                </button>
              </div>
            )}
          </div>

          {/* Batch-level progress bar ONLY when embedded (hideProcessingPreview = true) and not all settled (Section 3) */}
          {hideProcessingPreview && !allSettled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                <span style={{ color: C.mid }}>
                  {completedCount} of {totalCount} images ready
                </span>
                <span style={{ color: '#521D9C', fontWeight: 600 }}>
                  {totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0}%
                </span>
              </div>
              <div
                style={{
                  width: '100%',
                  height: 6,
                  background: C.lighter,
                  borderRadius: 3,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${totalCount > 0 ? (completedCount / totalCount) * 100 : 0}%`,
                    height: '100%',
                    background: 'linear-gradient(90deg, #521D9C 0%, #754AB0 100%)',
                    borderRadius: 3,
                    transition: 'width 0.4s ease-out',
                  }}
                />
              </div>
            </div>
          )}

          {/* Variations Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 12,
              width: '100%',
            }}
          >
            {displayJobs.map((job, idx) => {
              const status = statuses[job.id] ?? 'QUEUED';
              const isCompleted = status === 'COMPLETED';
              const isFailed = status === 'FAILED';
              const isCancelled = status === 'CANCELLED';
              const isTerminalFailed = isFailed || isCancelled;
              const isQueued = status === 'QUEUED';
              const isProcessing = !isCompleted && !isTerminalFailed && !isQueued;
              const cardProgress = STATUS_PROGRESS[status] ?? 10;
              const cardStep = getJobStepInfo(status);
              const resultUrl = resultQueries[idx]?.data?.url;
              const isSelected = selected === idx;

              return (
                <div
                  key={job.id}
                  onClick={() => setSelected(idx)}
                  style={{
                    position: 'relative',
                    background: isSelected
                      ? `linear-gradient(${C.card}, ${C.card}) padding-box, linear-gradient(180deg, #521D9C 0%, #754AB0 100%) border-box`
                      : `linear-gradient(${C.card}, ${C.card}) padding-box, linear-gradient(${C.border}, ${C.border}) border-box`,
                    border: '1.5px solid transparent',
                    borderRadius: 12,
                    padding: 0,
                    overflow: 'hidden',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    boxShadow: isSelected ? '0 4px 12px rgba(82, 29, 156, 0.12)' : 'none',
                    transition: 'box-shadow 0.2s, transform 0.2s',
                    boxSizing: 'border-box',
                  }}
                >
                  {/* Image section */}
                  <div
                    style={{
                      width: '100%',
                      aspectRatio: '3/4',
                      position: 'relative',
                      background: C.lighter,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                    }}
                  >
                    {isCompleted && resultUrl ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={resultUrl}
                          alt={job.label}
                          draggable={false}
                          onContextMenu={(e) => e.preventDefault()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(idx);
                            setZoomUrl(resultUrl);
                            requestAnimationFrame(() => setZoomVisible(true));
                          }}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            objectPosition: 'top center',
                            cursor: 'pointer',
                            WebkitTouchCallout: 'none',
                            WebkitUserSelect: 'none',
                            userSelect: 'none',
                          }}
                        />
                        {/* Completion Badge (Section 7) */}
                        <div
                          className="completion-pop"
                          aria-hidden="true"
                          style={{
                            position: 'absolute',
                            top: 8,
                            left: 8,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            background: 'rgba(16, 185, 129, 0.92)',
                            color: '#FFFFFF',
                            padding: '3px 7px',
                            borderRadius: 6,
                            fontSize: 10,
                            fontWeight: 600,
                            backdropFilter: 'blur(4px)',
                            boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
                            zIndex: 2,
                          }}
                        >
                          <CheckIcon size={11} color="#FFFFFF" />
                          <span>Ready</span>
                        </div>
                      </>
                    ) : isTerminalFailed ? (
                      <>
                        {/* Terminal Failed or Cancelled state (Section 8) */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={garmentPreviewUrl || job.thumbnailUrl}
                          alt={job.label}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            objectPosition: 'top center',
                            filter: 'grayscale(60%)',
                            opacity: 0.35,
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: 12,
                            gap: 6,
                            background: 'rgba(43, 20, 78, 0.5)',
                            textAlign: 'center',
                          }}
                        >
                          <div
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: '50%',
                              background: isFailed
                                ? 'rgba(239, 68, 68, 0.2)'
                                : 'rgba(156, 163, 175, 0.2)',
                              border: `1px solid ${
                                isFailed ? 'rgba(239, 68, 68, 0.5)' : 'rgba(156, 163, 175, 0.5)'
                              }`,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: isFailed ? '#EF4444' : '#9CA3AF',
                            }}
                          >
                            <XIcon size={18} color="currentColor" />
                          </div>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: '#FFFFFF',
                              textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                            }}
                          >
                            {isFailed ? 'Generation failed' : 'Generation cancelled'}
                          </span>
                        </div>
                      </>
                    ) : (
                      <>
                        {/* Non-terminal loading state: Queued or Processing (Sections 1, 2, 4, 5) */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={garmentPreviewUrl || job.thumbnailUrl}
                          alt={job.label}
                          className={isProcessing ? 'garment-deblur processing-pulse' : ''}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            objectPosition: 'top center',
                            filter: isQueued ? 'blur(4px)' : undefined,
                            opacity: 0.65,
                          }}
                        />
                        {isProcessing && (
                          <>
                            <div className="scan-line" aria-hidden="true" />
                            <div className="shimmer" aria-hidden="true" />
                          </>
                        )}
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-between',
                            padding: 8,
                            background:
                              'linear-gradient(180deg, rgba(43,20,78,0.04) 0%, rgba(43,20,78,0.4) 100%)',
                            pointerEvents: 'none',
                          }}
                        >
                          {/* Top badge */}
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                            }}
                          >
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                padding: '2px 6px',
                                borderRadius: 4,
                                background: isQueued
                                  ? 'rgba(82, 29, 156, 0.35)'
                                  : 'rgba(82, 29, 156, 0.8)',
                                color: '#FFFFFF',
                                backdropFilter: 'blur(4px)',
                                border: '1px solid rgba(255, 255, 255, 0.15)',
                              }}
                            >
                              {isQueued
                                ? 'Queued'
                                : `Stage ${cardStep.stepIndex}/${cardStep.totalSteps}`}
                            </span>
                            {isProcessing && (
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 700,
                                  color: '#FFFFFF',
                                  textShadow: '0 1px 2px rgba(0,0,0,0.7)',
                                }}
                              >
                                {cardProgress}%
                              </span>
                            )}
                          </div>

                          {/* Bottom stage info and mini progress bar */}
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 5,
                              background: 'rgba(43, 20, 78, 0.6)',
                              backdropFilter: 'blur(8px)',
                              padding: '6px 8px',
                              borderRadius: 8,
                              border: '1px solid rgba(255, 255, 255, 0.12)',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 600,
                                  color: '#FFFFFF',
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                }}
                              >
                                {isQueued ? 'Waiting…' : cardStep.stepLabel}
                              </span>
                            </div>
                            {isProcessing && (
                              <div
                                style={{
                                  width: '100%',
                                  height: 4,
                                  background: 'rgba(255, 255, 255, 0.2)',
                                  borderRadius: 2,
                                  overflow: 'hidden',
                                }}
                              >
                                <div
                                  style={{
                                    width: `${cardProgress}%`,
                                    height: '100%',
                                    background: 'linear-gradient(90deg, #754AB0 0%, #BD2587 100%)',
                                    borderRadius: 2,
                                    transition: 'width 0.4s ease-out',
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Actions row — below the image, not overlaid on top of it.
                      Order: Regenerate (or Use this, in embedded contexts) first, then Download,
                      then Save to Drive. */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'stretch',
                      borderTop: `1px solid ${C.border}`,
                      padding: '0 6px',
                    }}
                  >
                    {onUseImage && isCompleted && resultUrl && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onUseImage({ url: resultUrl, jobId: job.id, poseLabel: job.label });
                        }}
                        style={{
                          flex: 1,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 3,
                          minWidth: 0,
                          padding: '8px 2px',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          color: '#521D9C',
                        }}
                      >
                        <CheckIcon color="#521D9C" size={14} />
                        <span style={{ fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap' }}>
                          Use this
                        </span>
                      </button>
                    )}
                    {REGENERATE_ENABLED &&
                      !onUseImage &&
                      isCompleted &&
                      resultUrl &&
                      !downloadedJobIds.has(job.id) && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openReasonModal(job.id);
                          }}
                          disabled={regenerating}
                          style={{
                            flex: 1,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 3,
                            minWidth: 0,
                            padding: '8px 2px',
                            background: 'none',
                            border: 'none',
                            cursor: regenerating ? 'not-allowed' : 'pointer',
                            opacity: regenerating ? 0.6 : 1,
                            color: C.pink,
                          }}
                        >
                          <RegenerateIcon size={16} />
                          <span style={{ fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap' }}>
                            Regenerate
                          </span>
                        </button>
                      )}
                    {!hideDownload && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (resultUrl) downloadImage(resultUrl, job.id);
                        }}
                        style={{
                          flex: 1,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 3,
                          minWidth: 0,
                          padding: '8px 2px',
                          background: 'none',
                          border: 'none',
                          cursor: isCompleted && resultUrl ? 'pointer' : 'not-allowed',
                          opacity: isCompleted && resultUrl ? 1 : 0.45,
                          color: C.mid,
                        }}
                      >
                        <DownloadIcon size={16} />
                        <span style={{ fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap' }}>
                          Download
                        </span>
                      </button>
                    )}
                    {GOOGLE_DRIVE_ENABLED && !hideGoogleDrive && isCompleted && resultUrl && (
                      <button
                        type="button"
                        disabled={exportingToDrive === job.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          saveToDrive(job.id);
                        }}
                        title={
                          driveStatus.data?.status === 'CONNECTED'
                            ? 'Save to Google Drive'
                            : 'Connect Google Drive'
                        }
                        style={{
                          flex: 1,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 3,
                          minWidth: 0,
                          padding: '8px 2px',
                          background: 'none',
                          border: 'none',
                          cursor: exportingToDrive === job.id ? 'not-allowed' : 'pointer',
                          opacity: exportingToDrive === job.id ? 0.6 : 1,
                          color: C.mid,
                        }}
                      >
                        {exportingToDrive === job.id ? (
                          <SpinnerIcon size={16} />
                        ) : (
                          <DriveIcon size={16} />
                        )}
                        <span style={{ fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap' }}>
                          Save to Drive
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Batch-level accessibility announcement (Section 14) */}
        <div
          aria-live="polite"
          aria-atomic="true"
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: 'hidden',
            clip: 'rect(0, 0, 0, 0)',
            whiteSpace: 'nowrap',
            border: 0,
          }}
        >
          {allSettled
            ? `${completedCount} of ${totalCount} images ready.`
            : `Generating catalogue images. ${completedCount} of ${totalCount} images ready. ${PROCESSING_MESSAGES[activeMessageIndex]}.`}
        </div>
        {!hideCatalogueLink && (
          <Link
            href={`/catalogs/${catalogueId}`}
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: C.pink,
              textDecoration: 'none',
              alignSelf: 'flex-start',
              marginTop: -8,
            }}
          >
            View full catalogue →
          </Link>
        )}
      </div>

      {zoomUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onClick={() => {
            setZoomVisible(false);
            setTimeout(() => setZoomUrl(null), 300);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setZoomVisible(false);
              setTimeout(() => setZoomUrl(null), 300);
            }
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
            onClick={() => {
              setZoomVisible(false);
              setTimeout(() => setZoomUrl(null), 300);
            }}
            style={{
              position: 'absolute',
              top: 20,
              right: 20,
              width: 40,
              height: 40,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.15)',
              border: 'none',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <XIcon size={20} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoomUrl}
            alt=""
            draggable={false}
            onContextMenu={(e) => e.preventDefault()}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              borderRadius: 8,
              transform: zoomVisible ? 'scale(1)' : 'scale(0.95)',
              opacity: zoomVisible ? 1 : 0,
              transition: 'transform 300ms ease-out, opacity 300ms ease-out',
              pointerEvents: 'none',
              WebkitTouchCallout: 'none',
              WebkitUserSelect: 'none',
              userSelect: 'none',
            }}
          />
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
            <p style={{ margin: 0, fontSize: 12.5, color: C.mid, lineHeight: 1.5 }}>
              You get {FREE_REGENERATE_DAILY_LIMIT} free regenerations a day. Once this image is
              downloaded it can no longer be regenerated.
            </p>
            <div
              style={{
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                background: C.lighter,
              }}
            >
              <PremiumSelect
                ariaLabel="Reason for regenerating"
                value={regenerateReason}
                onChange={(v) => setRegenerateReason(String(v))}
                options={reasonOptions.map((r) => ({ value: r, label: r }))}
                disabled={regenerating}
                placeholder="Select a reason…"
                fullWidth
                height={42}
                fontSize={13}
              />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setReasonModalJobId(null)}
                disabled={regenerating}
                style={{
                  padding: '10px 18px',
                  borderRadius: 8,
                  background: 'transparent',
                  color: C.mid,
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
    </>
  );
}
