# Studio: Inline Generation Results in Right Panel

## Context

After the single-page studio redesign (`docs/superpowers/specs/2026-06-17-studio-single-page-design.md`), clicking Generate still redirects to `/catalogues/{catalogueId}` to see results. The right panel (`PreviewPanel`) is purely static. The request: stop redirecting — render generation progress and results inline in the right panel instead.

## Data already available

- `POST /v1/jobs/tryon` returns `{ catalogueId, jobIds }` (`apps/api/src/modules/jobs/create.ts`) — `jobIds` is in the same order as the `poseIds` array sent in the request (confirmed: `for (const poseId of poseIds) { ...; created.push(job.id); }`).
- `useJobStream` (`apps/catalogues-web/src/hooks/use-job-stream.ts`) — existing SSE hook subscribing to `/v1/jobs/stream`, delivers `{ jobId, status, ... }` events for any job belonging to the logged-in user. Already used on `/catalogues/[id]` to live-update job status.
- `GET /v1/jobs/:id/result` — existing endpoint returning `{ url }` for a completed job's image, already used on `/catalogues/[id]/preview`.
- `poses.items` (already loaded in studio for the Pose section) has `id`, `label`, `thumbnailUrl` per pose — used to label/thumbnail each job row without an extra fetch.

## State change in `page.tsx`

New state: `activeGeneration: { catalogueId: string; jobs: { id: string; poseId: string; label: string; thumbnailUrl: string }[] } | null`, initially `null`.

- `handleSubmit`'s non-Amazon-multi-pose-modal branch: after `const { catalogueId, jobIds } = await api.post(...)`, zip `poseIds[i]` ↔ `jobIds[i]` (same order), look up each pose's `label`/`thumbnailUrl` from `poses.items`, call `setActiveGeneration({ catalogueId, jobs })`. Remove the `router.push(...)` call.
- `submitAmazonPose`: same idea but two API calls (main pose, then remaining poses against the same `catalogueId`) — concatenate both calls' `jobIds` with their respective `poseId`s (`[mainPoseId, ...remainingPoseIds]` in that order) into one `jobs` array, then one `setActiveGeneration` call after both requests succeed. Remove the `router.push(...)` call.
- `qc.invalidateQueries({ queryKey: ['catalogues'] })` / `['credits']` stay — the Catalogues list and credit balance still need to reflect the new job even though we don't navigate there.
- `useRouter` import and `const router = useRouter()` are removed — no remaining call sites once both `router.push` calls are gone.

A new successful submit simply calls `setActiveGeneration` again, overwriting the previous batch — no explicit "clear" step needed, satisfying "reset to new batch on next successful submit."

## New component: `GenerationPanel`

`apps/catalogues-web/src/app/(app)/studio/generation-panel.tsx`, props:

```typescript
interface GenerationJob {
  id: string;
  poseId: string;
  label: string;
  thumbnailUrl: string;
}
interface GenerationPanelProps {
  catalogueId: string;
  jobs: GenerationJob[];
}
```

Renders, inside the same outer chrome `PreviewPanel` uses (`width:100%, height:100%, borderRadius:20, background:rgba(245,245,245,0.4), boxShadow: inset 0 0 0 1px border + drop shadow, overflow:hidden, display:flex, flexDirection:column`):

- A header row (matches `PreviewPanel`'s header height/border) showing "Generating Catalogue" and a `Link` to `/catalogues/{catalogueId}` reading "View full catalogue →" — visible immediately, not gated on completion.
- A scrollable list, one row per job: thumbnail square (pose's `thumbnailUrl`, or the live result image once completed), pose `label`, and a status badge/text. Status badge maps to the same status vocabulary used elsewhere in the app (`QUEUED`, `PREPROCESSING`, `GENERATING`, `UPLOADING`, `COMPLETED`, `FAILED`, `CANCELLED`) with `COMPLETED` rendering the actual result image instead of the pose thumbnail.

Internally:
- Local state `statuses: Record<string, string>` initialized from `'QUEUED'` for every job, updated via `useJobStream` filtering events to `jobs.map(j => j.id)`.
- `useQueries` (same pattern as `/catalogues/[id]/preview/page.tsx`) fetching `/v1/jobs/{id}/result` only for jobs whose `statuses[id] === 'COMPLETED'`, to get the real image URL once available.
- No `refetchInterval` polling fallback needed — `useJobStream`'s SSE reconnect-with-backoff already covers drops, matching the existing `/catalogues/[id]` page's reliance on the same hook without a fallback poll for individual job rows (the catalogue list page does keep a 5-minute fallback poll on its aggregate `catalogue` query, but `GenerationPanel` has no aggregate query to refresh — it operates purely on the job IDs already known at submit time).

## Right column wiring in `page.tsx`

```tsx
<div style={{ width: 480, flexShrink: 0 }}>
  {activeGeneration ? (
    <GenerationPanel catalogueId={activeGeneration.catalogueId} jobs={activeGeneration.jobs} />
  ) : (
    <PreviewPanel />
  )}
</div>
```

## Out of scope

- No changes to `/catalogues/[id]` or its preview page.
- No changes to credit deduction, job creation validation, or dispatcher logic.
- No "cancel from studio" action — cancellation, if needed, still happens from the Catalogues page.

## Testing

No automated test suite for `apps/catalogues-web` (project convention). Manual verification:
1. Single pose, non-Amazon: submit, panel shows one row, status updates live (QUEUED → ... → COMPLETED with image), no redirect occurs.
2. Multiple poses: panel shows one row per pose, each updates independently.
3. Amazon main-listing + multiple poses: confirm the existing pose-picker modal still appears, and after picking, the panel shows all submitted poses (main + remaining) as one combined list.
4. "View full catalogue →" link navigates to `/catalogues/{catalogueId}` and shows the same jobs there.
5. Submitting a second batch after the first completes replaces the panel's contents with the new batch.
6. A job that fails (`FAILED` status) shows a failed state in its row, no app crash.
