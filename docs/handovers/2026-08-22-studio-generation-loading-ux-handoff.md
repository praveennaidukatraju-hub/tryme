# Handover: Studio generation loading UX enhancement

**For:** antigravity CLI (implementer)
**From:** Claude — architect/reviewer only on this initiative. Nothing is implemented yet.
This handoff is the product of a multi-round design review (initial demo concept →
verified against actual dispatcher/data architecture → two correctness corrections →
two final polish notes). Every claim below about what data currently exists has been
checked against the live code, not assumed.
**Branch:** create a new branch off `dev` — e.g. `feature/studio-generation-loading-ux`.
Do **not** implement this on `feat/google-drive-export` (the currently checked-out
branch) — that branch is a separate, unrelated in-flight feature (Google Drive export)
already tracking its own PR, and this UI work would pollute that diff. `dev` is current
as of this handoff (`0c2a2eac`, fast-forwarded from `origin/dev` today).
**Note on current working tree:** `apps/catalogues-web/src/app/icon.svg` shows as a
locally deleted, uncommitted file (`git status`) on `feat/google-drive-export` right now.
It's unrelated to this task — don't inherit or fix it when branching off `dev`; flag it
to the user separately if it turns out to be intentional in-progress work on that branch.

## Goal

Improve the perceived responsiveness and quality of the existing generation experience
without modifying the generation backend, inventing partial-output data, or rebuilding
functionality that already exists. This is a **frontend-only** presentation improvement.

Preserve the current behavior where each completed job immediately displays its real
generated image independently of sibling jobs — this already works today
(`generation-panel.tsx:815`, keyed off `statuses[job.id]` per card) and must not regress.

**File in scope:** `apps/catalogues-web/src/app/(app)/studio/generation-panel.tsx`.

---

## 1. Replace generic per-card spinner

For every non-terminal generation card, replace the current generic spinner-only state
(currently lines ~842-857) with stage-aware feedback:

```text
[ animated input garment preview ]

Understanding Fabric
45%

████████░░░░
```

Reuse existing frontend data — do not introduce new backend state:

* `statuses[job.id]`
* `STATUS_PROGRESS[status]` (line 40)
* existing `steps[]` (line 51)
* `isCompleted` / `isFailed`

**Important:** `STATUS_PROGRESS` is a fixed stage mapping (`QUEUED → 10`,
`GENERATING → 60`, etc.), not real inference/render completion. Do not use copy implying
that N% of the output image has physically been rendered — this is progress through known
workflow stages only.

## 2. Add stage-specific card UI

Each active card should visually communicate its current workflow state (QUEUED /
PROCESSING + step label / COMPLETED / FAILED-CANCELLED). Use the exact status-to-step
mapping already available in the app (the same threshold logic Block 1 already uses at
lines 429-433 — apply it per-card using that card's own `STATUS_PROGRESS[status]` instead
of the batch-averaged `progressPercent`). Do not fabricate a stage the frontend can't
infer from existing status information.

## 3. Add batch-level progress — placement depends on context

```ts
const completedCount = jobs.filter(job => statuses[job.id] === 'COMPLETED').length;
const totalCount = jobs.length;
```

**Do not render this as a second percentage bar in the normal (non-embedded) Studio
view.** Block 1's existing `progressPercent` (lines 235-237) already averages
`STATUS_PROGRESS` continuously across every job in the batch and is already the
batch-level progress indicator on screen there — it moves smoothly (a QUEUED job
contributes 10, GENERATING contributes 60, etc.). `completedCount / totalCount * 100` is a
different, coarser number that only jumps when a job fully finishes. Showing both at once
(e.g. Block 1 reads 62%, this new indicator reads 40%) makes the app look like it
contradicts itself about its own progress.

* **Non-embedded Studio view (Block 1 visible):** show plain count text only —
  `"2 of 5 images ready"` — no bar, no percentage. Block 1's existing bar already owns
  that role.
* **Embedded view (`hideProcessingPreview: true`, Block 1 doesn't render):** here the
  count *is* the only progress signal on screen, so the bar-with-percentage from the
  original mockup is genuinely additive — render `completedCount / totalCount * 100` as a
  bar in that case.

Either way, this indicator must never block or delay individual completed results —
image #1 must keep appearing immediately today's way while #2-#5 are still processing.

## 4. Add animated input-garment treatment

During generation, animate over the existing input/reference asset
(`garmentPreviewUrl` or `job.thumbnailUrl`) — not a partial generated result, which does
not exist in the frontend until `COMPLETED`.

Recommended effects (decorative only): subtle vertical purple scan line, faint shimmer,
soft outline glow, optional SVG garment-outline pulse, subtle breathing animation,
optional simulated de-blur.

**Use:** "Analyzing garment details", "Reading fabric structure", "Preparing garment
reference", "Preserving patterns and texture".
**Do not use:** "Reconstructing your generated image", "48% of your image is rendered",
"Building the final image progressively" — none of these are true; the real dispatcher
only produces a finished asset at the end, uploaded to R2 on `COMPLETED`, never streamed
mid-generation.

## 5. Optional input de-blur animation

A blurred copy of the *input thumbnail* may gradually sharpen while generation is active
(`filter: blur(8px)` → `blur(2px)`, may loop subtly on long-running jobs). Must always
operate on the input/reference image, never represent itself as partial generated output.
When the real asset arrives on `COMPLETED`, replace the loading visualization atomically
with the actual result via the existing completion flow — no transition/crossfade needed
beyond what already happens.

## 6. Rotating processing microcopy

Rotate short messages every ~2-3s while jobs are active. Reuse `steps[].label` values
rather than maintaining a second workflow-label system.

**Use one parent-level interval, not one per card:**

```ts
useEffect(() => {
  const interval = setInterval(() => {
    setActiveMessageIndex(prev => (prev + 1) % processingMessages.length);
  }, 2500);
  return () => clearInterval(interval);
}, []);
```

Keep the interval active only while relevant jobs are processing, if practical (e.g. gate
on `!allSettled`).

## 7. Completion animation

On a job's transition into `COMPLETED`, animate the existing checkmark/ready UI:
`opacity 0→1`, `scale 0.7→1.05→1`, ~300-450ms. No confetti, no particle effects, no
blocking animation. Existing download action continues to appear normally.

## 8. Failed and cancelled jobs

Existing code already treats both as terminal-unsuccessful
(`isFailed = status === 'FAILED' || status === 'CANCELLED'`, line 777).

**Failed or cancelled jobs must immediately stop all processing animations** — spinner,
shimmer, scan line, de-blur loop, pulsing outline, and that card's processing microcopy.
Show a terminal message; branch on the raw `status` string (already in scope per-card) to
distinguish copy: `"Generation failed"` for `FAILED`, `"Generation cancelled"` for
`CANCELLED`. No progress percentage continues to display after either state.

**No retry button or retry affordance.** Verified: `generation-panel.tsx` has no retry
action today (no `retry`/`Retry` anywhere in the file). Retry is out of scope — don't
invent one as part of this UX work.

## 9. Do not implement

Partial generated-image streaming, progressive real-output rendering, ComfyUI
preview-frame polling, R2 partial-result storage, new dispatcher events, WebSocket
streaming for intermediate renders, backend generation-progress telemetry, dispatcher
architecture changes, database schema changes, estimated completion times, hardcoded
generation-duration promises, artificial delay after an output is already ready, waiting
for sibling jobs before showing completed outputs.

## 10. Timing copy

No numerical ETA (e.g. "usually takes 20-40 seconds") — there is no production p50/p90
generation-time measurement currently surfaced to the frontend, and queue load can
substantially change duration. Use neutral copy: "Generating your catalogue images" /
"Your images are being prepared". Avoid even soft phrasing like "usually just a few
moments" — if a GPU queue backs up, that still sets an expectation the app can't guarantee.

## 11. Main processing panel (Block 1)

Enhance using the already-defined `steps[]`/threshold logic — e.g. add "Stage 2 of 6"
under the current step label. Stage progression must come from the existing frontend
status mapping; this is stage progress, not real render percentage, same caveat as
everywhere else in this doc.

## 12. Result card states

Five states per card: Queued, Processing (scan + stage label + %), Completed (real
output, unchanged from current behavior), Failed, Cancelled. See prior review rounds in
this conversation for the exact mockups — implement per sections 1-2 and 8 above.

## 13. Reduced motion

The project already has a scoped `prefers-reduced-motion` convention in `globals.css`
(around line 354, targeting `.sidebar-drawer-panel`) — follow the same pattern, don't add
a blanket rule:

```css
@media (prefers-reduced-motion: reduce) {
  .scan-line,
  .shimmer,
  .processing-pulse,
  .garment-deblur {
    animation: none;
    transition: none;
  }
}
```

**Implementation note:** `generation-panel.tsx` is 100% inline `style={{}}` objects today
— there's no existing CSS module or component-scoped stylesheet for it, and `@keyframes`
can't be expressed inline. Add the new keyframes to `globals.css` (same file the existing
reduced-motion block already lives in) rather than trying to force them inline; the
per-tile percentage/color/width values that do need to be dynamic can stay inline as
today, only the keyframe animations themselves need to live in the stylesheet.

## 14. Accessibility

One batch-level `aria-live="polite"` announcement source — not one live region per card
(five parallel jobs would create overlapping/noisy screen-reader announcements). Examples:
`"2 of 5 images complete."`, `"Generating catalogue images. Understanding fabric."`.
Decorative scan lines, shimmer, and SVG traces get `aria-hidden="true"`.

## 15. Performance

Prefer `transform`/`opacity`/CSS gradients/pseudo-elements/lightweight SVG. Avoid canvas
or JS-driven per-frame animation. GPU-friendly CSS animation for scan/shimmer. Don't
trigger large React re-renders every animation frame — the rotating-microcopy interval
(section 6) should be the only new timer-driven state update.

## 16. Preserve existing architecture

Don't rewrite existing per-job result logic. `statuses[job.id]`, `isCompleted`,
`isFailed` remain the source of truth; this UX decorates that architecture, it doesn't
replace it. Independence must remain intact: job 1 `COMPLETED` shows its real image
immediately regardless of jobs 2-5's state.

---

## Acceptance criteria

* Existing independent per-job completion behavior unchanged; image #1 can show while
  #2-#5 remain active.
* Generic spinner-only cards replaced with stage-aware loading UI (stage label + %).
* `STATUS_PROGRESS` treated as stage-derived progress only, never worded as real render %.
* Non-embedded Studio view: new batch indicator is count-only text, no second progress
  bar competing with Block 1's existing bar. Embedded (`hideProcessingPreview`) view: bar
  derived from `completedCount / totalCount`.
* Scan/shimmer/de-blur effects operate only on existing input/reference assets; copy never
  implies partial generated output exists.
* Failed/cancelled cards stop all animations and stop showing any progress %; no retry
  button introduced.
* No numerical ETA anywhere.
* No backend/API/database/dispatcher changes.
* One parent-level rotating-message timer, not one per card.
* Completion checkmark animates subtly (300-450ms, no confetti/particles).
* New `@keyframes` live in `globals.css` alongside the existing reduced-motion block;
  `prefers-reduced-motion: reduce` disables them, following that file's existing pattern.
* Single `aria-live="polite"` region for the batch, not one per card; decorative elements
  `aria-hidden="true"`.
* Existing download action and completed-result rendering logic unchanged.
* `pnpm --filter @tryme/web typecheck` and `pnpm --filter @tryme/web lint` clean.
* Manual walkthrough in a running Studio instance with a real multi-job batch (not just
  code review) — confirm cards visibly diverge in stage as jobs progress at different
  rates, confirm reduced-motion setting actually disables the new animations, confirm the
  embedded (`hideProcessingPreview`) path still renders correctly (used by the Shopify
  plugin embed).
* Report back: what was built per section, and flag anywhere the live code disagreed with
  this handoff's line-number references (they're accurate as of `38d1c6b2` / current `dev`
  tip `0c2a2eac`, but may have drifted) rather than silently guessing.
