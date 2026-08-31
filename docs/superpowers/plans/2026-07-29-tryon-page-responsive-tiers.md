# TryOn Page — Viewport-Tier Responsive Rebuild Implementation Plan

**Goal:** Make the TryOn page (`/tryon`) in `apps/catalogues-web` fully responsive across Mobile, Tablet, and Desktop viewport sizes while keeping Desktop (≥1024px) 100% byte-for-byte identical to the current design.

---

### Task Breakdown

- **Task 1: Extract data and state logic into `useTryOnData` hook**
  - Create `apps/catalogues-web/src/app/(app)/tryon/use-tryon-data.ts`.
  - Move all state (`personFile`, `personPreview`, `personProgress`, `generating`, `resultUrl`, `resultJobId`, `pendingJobId`, `selectedGarmentJob`, `showGarmentPicker`, `showContact`, etc.), queries (`tryon-categories`, `credits`, `me`), effects, job stream handlers, and action handlers (`handleGenerate`, `handleSelectGarment`, `handleDownloadResult`, `handleShareResult`, `togglePreviewFullscreen`, `pickFile`) into this custom hook.
  - Verify with typecheck and lint.

- **Task 2: Define `TryOnLayoutProps` type interface**
  - Create `apps/catalogues-web/src/app/(app)/tryon/layouts/types.ts`.
  - Export `TryOnLayoutProps = ReturnType<typeof useTryOnData>`.

- **Task 3: Extract verbatim `Desktop` layout component**
  - Create `apps/catalogues-web/src/app/(app)/tryon/layouts/Desktop.tsx`.
  - Move today's desktop JSX markup into this presentational component without altering any inline styles or structure.

- **Task 4: Create `Tablet` layout component**
  - Create `apps/catalogues-web/src/app/(app)/tryon/layouts/Tablet.tsx`.
  - Implement a tablet-responsive layout (640px–1023px) with stacked main columns, 2x2 step indicator grid, side-by-side or stacked upload cards, and a 2x2 badge footer grid.

- **Task 5: Create `Mobile` layout component**
  - Create `apps/catalogues-web/src/app/(app)/tryon/layouts/Mobile.tsx`.
  - Implement a mobile-responsive layout (<640px) with single-column flow (`1fr`), 2x2 step indicators, stacked upload cards, full-width action buttons, 2x2 badge footer grid, and scaled font sizes/paddings.

- **Task 6: Rewrite `page.tsx` as a thin layout dispatcher**
  - Update `apps/catalogues-web/src/app/(app)/tryon/page.tsx` to call `useTryOnData()` and `useBreakpoint()`, dispatching to `Mobile`, `Tablet`, or `Desktop` based on the active viewport tier.

- **Task 7: Final verification and progress log**
  - Run typecheck (`pnpm --filter @tryme/web typecheck`), lint (`pnpm --filter @tryme/web lint`), and build (`pnpm --filter @tryme/web build`).
  - Add dated entry to `docs/progress.md`.
