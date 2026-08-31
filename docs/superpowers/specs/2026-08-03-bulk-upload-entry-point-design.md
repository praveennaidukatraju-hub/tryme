# Bulk Upload entry point — design

## Problem

`apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/bulk-upload/page.tsx` already
implements the full Catalogue Image / Flat Image toggle (mirroring `ProductForm.tsx`'s
single-add flow), but no button in the app navigates to it. The products screen
(`subcategory/[id]/page.tsx`) only wires `ScreenHeader`'s single `action` slot to "Add Product".

## Design

1. **`ScreenHeader.tsx`**: replace the single `action?: { label, onClick }` prop with
   `actions?: { label: string; onClick: () => void }[]` (1–2 items).
   - 1 action: render exactly as today (single gradient button).
   - 2 actions: render a single "+" trigger button that opens a popup menu listing both
     actions, reusing the anchored-popup pattern already in `LibraryUserMenu.tsx` (fixed
     position under the trigger, backdrop click + Escape to close, closes on selection).
2. **`subcategory/[id]/page.tsx`**: pass two actions —
   - "Add Product" → `/tryon-library-app/subcategory/{id}/add-product` (existing route)
   - "Bulk Upload" → `/tryon-library-app/subcategory/{id}/bulk-upload` (existing route)

No changes to `ProductForm.tsx` or `bulk-upload/page.tsx` internals — both already implement
the Catalogue/Flat toggle correctly. This is a navigation-wiring fix only: no API, schema, or
backend changes.

## Testing

Manual verification in the browser: open a subcategory's products screen, confirm the "+"
menu shows both options, and each navigates to the correct existing screen.

## Status

Approved by user 2026-08-03 ("yes that's right, go ahead") — this also satisfies the spec
review gate; proceeding straight to planning/implementation given the trivial scope.
