# Studio Inline Generation Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the post-Generate redirect to `/catalogues/{catalogueId}` with a live progress + results view rendered in the studio's right panel, per `docs/superpowers/specs/2026-06-17-studio-inline-results-design.md`.

**Architecture:** Add a `GenerationPanel` component that subscribes to the existing `useJobStream` SSE hook for the submitted batch's job IDs and fetches `/v1/jobs/{id}/result` once each job completes. `page.tsx` stores the submitted batch in new `activeGeneration` state (set after a successful `handleSubmit`/`submitAmazonPose`, instead of calling `router.push`) and renders `GenerationPanel` in place of `PreviewPanel` whenever it's non-null.

**Tech Stack:** Next.js 15, React 18, TanStack Query, existing `useJobStream` SSE hook, existing `/v1/jobs/:id/result` endpoint. No backend changes.

## Global Constraints

- ESM only, TypeScript 5.6, no `console.log` in committed code.
- All components use `C` from `apps/web/src/components/tokens.ts`.
- No backend/API changes.
- `jobIds` returned by `POST /v1/jobs/tryon` are in the same order as the `poseIds` sent in that request (verified in `apps/api/src/modules/jobs/create.ts`).
- A new successful submit must overwrite `activeGeneration` (no explicit clear step) so the panel always reflects the latest batch.
- `apps/web` has no automated test suite — verification is manual in the browser per CLAUDE.md.

---

### Task 1: Create the `GenerationPanel` component

**Files:**
- Create: `apps/web/src/app/(app)/studio/generation-panel.tsx`

**Interfaces:**
- Produces:
  ```typescript
  export interface GenerationJob {
    id: string;
    poseId: string;
    label: string;
    thumbnailUrl: string;
  }
  export interface GenerationPanelProps {
    catalogueId: string;
    jobs: GenerationJob[];
  }
  export function GenerationPanel(props: GenerationPanelProps): React.ReactElement
  ```
- Consumes: `useJobStream` from `@/hooks/use-job-stream` (signature: `useJobStream(onEvent: (evt: { jobId: string; status: string }) => void): void`), `api` from `@/lib/api` (has `api.get<T>(path: string): Promise<T>`), `C` from `@/components/tokens`, `useQueries` from `@tanstack/react-query`, `Link` from `next/link`, `SpinnerIcon`/`XIcon` from `@/components/icons`.

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/app/(app)/studio/generation-panel.tsx
'use client';
import { useQueries } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SpinnerIcon, XIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { useJobStream } from '@/hooks/use-job-stream';
import { api } from '@/lib/api';

export interface GenerationJob {
  id: string;
  poseId: string;
  label: string;
  thumbnailUrl: string;
}

export interface GenerationPanelProps {
  catalogueId: string;
  jobs: GenerationJob[];
}

const STATUS_LABEL: Record<string, string> = {
  QUEUED: 'Queued',
  PREPROCESSING: 'Preparing…',
  GENERATING: 'Generating…',
  UPLOADING: 'Saving…',
  COMPLETED: 'Done',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

export function GenerationPanel({ catalogueId, jobs }: GenerationPanelProps) {
  const [statuses, setStatuses] = useState<Record<string, string>>(() =>
    Object.fromEntries(jobs.map((j) => [j.id, 'QUEUED'])),
  );

  // Reset local status map whenever a new batch of jobs arrives.
  useEffect(() => {
    setStatuses(Object.fromEntries(jobs.map((j) => [j.id, 'QUEUED'])));
  }, [jobs]);

  const jobIds = jobs.map((j) => j.id);
  useJobStream((evt) => {
    if (!jobIds.includes(evt.jobId)) return;
    setStatuses((prev) => ({ ...prev, [evt.jobId]: evt.status }));
  });

  const completedIds = jobs.filter((j) => statuses[j.id] === 'COMPLETED').map((j) => j.id);
  const resultQueries = useQueries({
    queries: jobs.map((j) => ({
      queryKey: ['job-result', j.id],
      queryFn: () => api.get<{ url: string }>(`/v1/jobs/${j.id}/result`),
      enabled: completedIds.includes(j.id),
      staleTime: 4 * 60 * 1000,
    })),
  });

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        borderRadius: 20,
        background: 'rgba(245,245,245,0.4)',
        boxShadow: `inset 0 0 0 1px ${C.border2}, 0 4px 15px rgba(0,0,0,0.08)`,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: 88,
          borderBottom: `1px solid ${C.border2}`,
          padding: '16px 20px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          justifyContent: 'center',
        }}
      >
        <span style={{ fontSize: 18, fontWeight: 600, color: C.text }}>Generating Catalogue</span>
        <Link
          href={`/catalogues/${catalogueId}`}
          style={{ fontSize: 13, fontWeight: 600, color: C.pink, textDecoration: 'none' }}
        >
          View full catalogue →
        </Link>
      </div>
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {jobs.map((job, i) => {
          const status = statuses[job.id] ?? 'QUEUED';
          const isCompleted = status === 'COMPLETED';
          const isFailed = status === 'FAILED' || status === 'CANCELLED';
          const resultUrl = resultQueries[i]?.data?.url;
          return (
            <div
              key={job.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: 10,
                borderRadius: 10,
                background: C.white,
                boxShadow: `inset 0 0 0 1px ${C.border2}`,
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 8,
                  overflow: 'hidden',
                  flexShrink: 0,
                  background: C.lighter,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {isCompleted && resultUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  // biome-ignore lint/performance/noImgElement: presigned R2 URL
                  <img
                    src={resultUrl}
                    alt={job.label}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  // biome-ignore lint/performance/noImgElement: presigned R2 URL
                  <img
                    src={job.thumbnailUrl}
                    alt={job.label}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      opacity: isCompleted ? 1 : 0.5,
                    }}
                  />
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{job.label}</div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: isFailed ? C.pink : C.mid,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginTop: 2,
                  }}
                >
                  {!isCompleted && !isFailed && <SpinnerIcon size={12} />}
                  {isFailed && <XIcon size={12} />}
                  {STATUS_LABEL[status] ?? status}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: no errors. (If `SpinnerIcon`/`XIcon` don't accept a `size` prop, check `apps/web/src/components/icons.tsx` for their actual signature and adjust — other call sites in `apps/web/src/app/(app)/studio/page.tsx` already use `<SpinnerIcon size={16} />` and `<XIcon size={14} />`, so `size` should be supported.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(app\)/studio/generation-panel.tsx
git commit -m "feat(web): add GenerationPanel for inline studio job progress/results"
```

---

### Task 2: Wire `activeGeneration` state and `handleSubmit`

**Files:**
- Modify: `apps/web/src/app/(app)/studio/page.tsx`

**Interfaces:**
- Consumes: `GenerationJob` type from `./generation-panel` (Task 1).
- Produces: state `activeGeneration: { catalogueId: string; jobs: GenerationJob[] } | null` — consumed by Task 3 when wiring the right column and by `submitAmazonPose` in this same task's surrounding code (Task 3 modifies `submitAmazonPose`, but both functions read/write the same `activeGeneration` setter introduced here).

- [ ] **Step 1: Add the import and state**

Add near the other type imports at the top of `page.tsx`:

```typescript
import type { GenerationJob } from './generation-panel';
```

Add state near `submitError`/`toast` (after `const [submitError, setSubmitError] = useState('');`):

```typescript
  const [activeGeneration, setActiveGeneration] = useState<{
    catalogueId: string;
    jobs: GenerationJob[];
  } | null>(null);
```

- [ ] **Step 2: Replace `handleSubmit`'s success path**

Find this block in `handleSubmit` (the non-Amazon-multi-pose-modal branch):

```typescript
      const { catalogueId } = await api.post<{ catalogueId: string }>('/v1/jobs/tryon', {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          backgroundId,
          poseIds,
          garmentTypeId: garmentTypeId || undefined,
          lowerCatalogId: effectiveLowerId,
          lowerGarmentKey: lowerGarmentKey || undefined,
          shoeCatalogId: effectiveShoesId,
        },
        aspectRatio: aspect,
        resolution,
        ...(effectivePlatform ? { platform: effectivePlatform } : {}),
      });
      // Credits were deducted server-side — refresh balance + catalogues list.
      qc.invalidateQueries({ queryKey: ['credits'] });
      qc.invalidateQueries({ queryKey: ['catalogues'] });
      router.push(`/catalogues/${catalogueId}`);
    } catch (e) {
      setSubmitError((e as Error).message);
      setIsSubmitting(false);
    }
  }
```

Replace with:

```typescript
      const { catalogueId, jobIds } = await api.post<{ catalogueId: string; jobIds: string[] }>(
        '/v1/jobs/tryon',
        {
          inputs: {
            upperGarmentKey: garmentKey,
            faceId,
            backgroundId,
            poseIds,
            garmentTypeId: garmentTypeId || undefined,
            lowerCatalogId: effectiveLowerId,
            lowerGarmentKey: lowerGarmentKey || undefined,
            shoeCatalogId: effectiveShoesId,
          },
          aspectRatio: aspect,
          resolution,
          ...(effectivePlatform ? { platform: effectivePlatform } : {}),
        },
      );
      // Credits were deducted server-side — refresh balance + catalogues list.
      qc.invalidateQueries({ queryKey: ['credits'] });
      qc.invalidateQueries({ queryKey: ['catalogues'] });
      setActiveGeneration({
        catalogueId,
        jobs: poseIds.map((poseId, i) => {
          const pose = poses?.items.find((p) => p.id === poseId);
          return {
            id: jobIds[i]!,
            poseId,
            label: pose?.label ?? `Pose ${i + 1}`,
            thumbnailUrl: pose?.thumbnailUrl ?? '',
          };
        }),
      });
      setIsSubmitting(false);
    } catch (e) {
      setSubmitError((e as Error).message);
      setIsSubmitting(false);
    }
  }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: clean, zero errors. `router` is still used in `submitAmazonPose` at this point (Task 3 replaces that call site and removes the import), so no unused-variable error should appear yet. If typecheck reports anything inside `handleSubmit`, fix it before proceeding.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(app\)/studio/page.tsx
git commit -m "feat(web): set activeGeneration instead of redirecting after handleSubmit"
```

---

### Task 3: Wire `submitAmazonPose`, the right column, and remove `useRouter`

**Files:**
- Modify: `apps/web/src/app/(app)/studio/page.tsx`

**Interfaces:**
- Consumes: `activeGeneration` state and `GenerationJob` type (Task 2), `GenerationPanel` component (Task 1).

- [ ] **Step 1: Replace `submitAmazonPose`'s success path**

Find:

```typescript
      // Main image: white Amazon-compliant background
      const { catalogueId } = await api.post<{ catalogueId: string }>('/v1/jobs/tryon', {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          backgroundId,
          poseIds: [mainPoseId],
          garmentTypeId: garmentTypeId || undefined,
          lowerCatalogId: effectiveLowerId,
          lowerGarmentKey: lowerGarmentKey || undefined,
          shoeCatalogId: effectiveShoesId,
        },
        aspectRatio: aspect,
        resolution,
        platform: 'Amazon',
      });

      // Remaining poses: same catalogue, original background, no Amazon override
      const remainingPoseIds = poseIds.filter((id) => id !== mainPoseId);
      if (remainingPoseIds.length > 0) {
        await api.post('/v1/jobs/tryon', {
          catalogueId,
          inputs: {
            upperGarmentKey: garmentKey,
            faceId,
            backgroundId,
            poseIds: remainingPoseIds,
            garmentTypeId: garmentTypeId || undefined,
            lowerCatalogId: effectiveLowerId,
            lowerGarmentKey: lowerGarmentKey || undefined,
            shoeCatalogId: effectiveShoesId,
          },
          aspectRatio: aspect,
          resolution,
        });
      }

      qc.invalidateQueries({ queryKey: ['credits'] });
      qc.invalidateQueries({ queryKey: ['catalogues'] });
      router.push(`/catalogues/${catalogueId}`);
    } catch (e) {
      setSubmitError((e as Error).message);
      setIsSubmitting(false);
    }
  }
```

Replace with:

```typescript
      // Main image: white Amazon-compliant background
      const { catalogueId, jobIds: mainJobIds } = await api.post<{
        catalogueId: string;
        jobIds: string[];
      }>('/v1/jobs/tryon', {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          backgroundId,
          poseIds: [mainPoseId],
          garmentTypeId: garmentTypeId || undefined,
          lowerCatalogId: effectiveLowerId,
          lowerGarmentKey: lowerGarmentKey || undefined,
          shoeCatalogId: effectiveShoesId,
        },
        aspectRatio: aspect,
        resolution,
        platform: 'Amazon',
      });

      // Remaining poses: same catalogue, original background, no Amazon override
      const remainingPoseIds = poseIds.filter((id) => id !== mainPoseId);
      let remainingJobIds: string[] = [];
      if (remainingPoseIds.length > 0) {
        const remaining = await api.post<{ jobIds: string[] }>('/v1/jobs/tryon', {
          catalogueId,
          inputs: {
            upperGarmentKey: garmentKey,
            faceId,
            backgroundId,
            poseIds: remainingPoseIds,
            garmentTypeId: garmentTypeId || undefined,
            lowerCatalogId: effectiveLowerId,
            lowerGarmentKey: lowerGarmentKey || undefined,
            shoeCatalogId: effectiveShoesId,
          },
          aspectRatio: aspect,
          resolution,
        });
        remainingJobIds = remaining.jobIds;
      }

      qc.invalidateQueries({ queryKey: ['credits'] });
      qc.invalidateQueries({ queryKey: ['catalogues'] });
      const orderedPoseIds = [mainPoseId, ...remainingPoseIds];
      const orderedJobIds = [...mainJobIds, ...remainingJobIds];
      setActiveGeneration({
        catalogueId,
        jobs: orderedPoseIds.map((poseId, i) => {
          const pose = poses?.items.find((p) => p.id === poseId);
          return {
            id: orderedJobIds[i]!,
            poseId,
            label: pose?.label ?? `Pose ${i + 1}`,
            thumbnailUrl: pose?.thumbnailUrl ?? '',
          };
        }),
      });
      setIsSubmitting(false);
    } catch (e) {
      setSubmitError((e as Error).message);
      setIsSubmitting(false);
    }
  }
```

- [ ] **Step 2: Remove `useRouter`**

Run: `grep -n "useRouter\|router\." apps/web/src/app/\(app\)/studio/page.tsx`
Expected: zero matches after this task's edits (both call sites were replaced in Task 2 and Step 1 above). Delete the import line `import { useRouter } from 'next/navigation';` and the declaration `const router = useRouter();`.

- [ ] **Step 3: Wire the right column**

Find:

```tsx
        <div style={{ width: 480, flexShrink: 0 }}>
          <PreviewPanel />
        </div>
```

Replace with:

```tsx
        <div style={{ width: 480, flexShrink: 0 }}>
          {activeGeneration ? (
            <GenerationPanel
              catalogueId={activeGeneration.catalogueId}
              jobs={activeGeneration.jobs}
            />
          ) : (
            <PreviewPanel />
          )}
        </div>
```

Add the import alongside the existing `PreviewPanel` import:

```typescript
import { GenerationPanel } from './generation-panel';
```

(The `GenerationJob` type import from Task 2 can stay as a separate `import type` line, or be merged into this one as `import { GenerationPanel, type GenerationJob } from './generation-panel';` — either is fine, just don't end up with two import statements for the same module path that typecheck would flag as redundant.)

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm --filter @tryme/web typecheck && pnpm --filter @tryme/web lint`
Expected: both clean (typecheck zero errors; lint zero errors, pre-existing warning count unaffected by this task beyond whatever `generation-panel.tsx` already introduced in Task 1).

- [ ] **Step 5: Manual verification**

With `pnpm --filter @tryme/web dev` running and logged in:
1. Submit a single-pose, non-Amazon job. Confirm: no redirect happens, the right panel switches from the empty-state `PreviewPanel` to `GenerationPanel` showing one row, status text updates as the job progresses (watch dev server logs or the dispatcher to confirm it's actually processing), and once `COMPLETED` the row shows the real result image.
2. Submit multiple poses (non-Amazon). Confirm one row per pose, each updating independently.
3. Trigger the Amazon main-listing flow with multiple poses selected (platform=Amazon, "Main listing" toggle, 2+ poses) — confirm the existing pose-picker modal still opens, and after confirming, the panel shows all submitted poses (main + remaining) as one combined list in `[mainPoseId, ...remainingPoseIds]` order.
4. Click "View full catalogue →" — confirm it navigates to `/catalogues/{catalogueId}` and shows the same jobs there.
5. After a batch completes, change a selection and submit again — confirm the panel's contents fully replace with the new batch (no old rows lingering).
6. If feasible, force or wait for a job to fail and confirm its row shows the failed state without crashing the page.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/\(app\)/studio/page.tsx
git commit -m "feat(web): render GenerationPanel inline instead of redirecting after generate"
```
