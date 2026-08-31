# TryOn Page — Viewport-Tier Responsive Rebuild — Design

## Goal

The TryOn page (`/tryon`) currently renders a fixed two-column layout (`gridTemplateColumns: '1fr 1.22fr'`) with fixed-width step indicators, side-by-side upload cards, and a 4-column badge footer. Below desktop widths (<1024px / <1280px), this layout overflows horizontally and elements squeeze into unreadable widths.

This spec defines a viewport-tier responsive rebuild of the TryOn page that:
1. **Preserves Desktop (≥1024px / ≥1280px) 100% byte-for-byte**: Zero visual or structural changes at desktop viewport widths.
2. **Introduces Tablet & Mobile Tier Layouts**: Stacks main columns, adjusts step indicators into flexible grids, stacks upload zones and actions cleanly on mobile, and scales font sizes and paddings appropriately.
3. **Preserves All Logic & Business Rules**: All state management, presigning, R2 uploads, job streaming, download/share handlers, and modal logic are extracted into a shared custom hook (`useTryOnData`), leaving presentational components completely pure.

## Architecture

```
apps/catalogues-web/src/app/(app)/tryon/
├── use-tryon-data.ts        — Shared custom hook owning all queries, state, effects, and action handlers
├── layouts/
│   ├── types.ts             — TryOnLayoutProps interface derived from ReturnType<typeof useTryOnData>
│   ├── Desktop.tsx          — Unchanged 100% verbatim copy of today's desktop layout
│   ├── Tablet.tsx           — Tablet-optimized presentational layout (640px – 1023px)
│   └── Mobile.tsx           — Mobile-optimized presentational layout (<640px)
└── page.tsx                 — Thin layout dispatcher using useBreakpoint()
```

## Viewport Tier Breakdown

- **Desktop (`desktop`, `laptop`, `small-laptop` ≥1024px)**: Renders `Desktop.tsx` (identical to today's 2-column grid, 4-step horizontal bar, side-by-side upload cards, 4-badge footer).
- **Tablet (`tablet` 640px–1023px)**: Renders `Tablet.tsx` (stacked 1-column main sections, 2x2 step indicator grid, side-by-side or stacked upload cards, 2x2 badge grid).
- **Mobile (`mobile` <640px)**: Renders `Mobile.tsx` (single-column layout `1fr`, 2x2 step indicator grid, stacked upload cards, full-width action buttons, 2x2 badge grid, optimized font sizes and touch targets).

## Invariants & Rules

- **Zero Logic Duplication**: All state (`personFile`, `selectedGarmentJob`, `generating`, `resultUrl`, `pendingJobId`, etc.), queries (`tryon-categories`, `credits`, `me`, `garment-images`), and handlers (`handleGenerate`, `handleSelectGarment`, `handleDownloadResult`, `handleShareResult`) live solely in `use-tryon-data.ts`.
- **Desktop Regression Bar**: On viewport ≥1024px, the output HTML and CSS structure must be byte-for-byte identical to the current `page.tsx`.
