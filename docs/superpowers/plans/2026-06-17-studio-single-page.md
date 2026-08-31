# Studio Single-Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the 4-step studio wizard (`apps/web/src/app/(app)/studio/page.tsx`) into one scrollable single-page form with a static right-side preview panel, per `docs/superpowers/specs/2026-06-17-studio-single-page-design.md`.

**Architecture:** Extract three small reusable pieces (a `useVisibleCount` ResizeObserver hook, a generic `SelectGridModal` component, and a static `PreviewPanel` component) into sibling files under `apps/web/src/app/(app)/studio/`, then modify `page.tsx` to: remove all step state, render every section unconditionally, wire Model/Background/Pose sections through the same inline-row + "View More" modal pattern Garment Type already uses, and move the Generate button into a left-column-only sticky footer next to the new `PreviewPanel`.

**Tech Stack:** Next.js 15 App Router, React 18, TanStack Query, no test framework for `apps/web` — verification is manual browser testing per CLAUDE.md.

## Global Constraints

- ESM only, TypeScript 5.6, no `console.log` in committed code (n/a here, no logging added).
- All components use `C` from `apps/web/src/components/tokens.ts` — never raw hex/hardcoded colors except where the existing file already does (preserve as-is, don't introduce new raw hex).
- No backend/API changes — this is a frontend-only restructuring.
- `pnpm --filter @tryme/web dev` must be running to manually verify each task in the browser per CLAUDE.md's UI-testing requirement.
- Commit only after each task's manual verification passes (per user's standing git policy — confirm with user before any `git commit`/`push`, do not commit automatically as part of plan execution unless user has pre-approved it for this branch).

---

### Task 1: Extract `useVisibleCount` hook

**Files:**
- Create: `apps/web/src/app/(app)/studio/use-visible-count.ts`
- Modify: `apps/web/src/app/(app)/studio/page.tsx:374-387` (replace inline `garmentVisibleCount`/`garmentRoRef`/`garmentRowRef` block with a call to the new hook)

**Interfaces:**
- Produces: `useVisibleCount(cardWidth: number, gap: number): { visibleCount: number; rowRef: (el: HTMLDivElement | null) => void }` — exported function. `cardWidth` is the card's pixel width, `gap` is the flex gap between cards. Returns the count of cards that fit in the observed row's current width, and a ref callback to attach to the row container.
- Consumes: nothing (pure hook, no dependency on other tasks).

- [ ] **Step 1: Create the hook file**

```typescript
// apps/web/src/app/(app)/studio/use-visible-count.ts
import { useCallback, useRef, useState } from 'react';

export function useVisibleCount(cardWidth: number, gap: number) {
  const [visibleCount, setVisibleCount] = useState(6);
  const roRef = useRef<ResizeObserver | null>(null);
  const rowRef = useCallback(
    (el: HTMLDivElement | null) => {
      roRef.current?.disconnect();
      roRef.current = null;
      if (!el) return;
      const ro = new ResizeObserver(([entry]) => {
        const w = entry?.contentRect.width ?? 0;
        const count = Math.max(1, Math.floor((w + gap) / (cardWidth + gap)));
        setVisibleCount(count);
      });
      ro.observe(el);
      roRef.current = ro;
    },
    [cardWidth, gap],
  );
  return { visibleCount, rowRef };
}
```

- [ ] **Step 2: Replace the inline implementation in `page.tsx`**

Find this block (`page.tsx:374-387`):

```typescript
  const [garmentVisibleCount, setGarmentVisibleCount] = useState(6);
  const garmentRoRef = useRef<ResizeObserver | null>(null);
  const garmentRowRef = useCallback((el: HTMLDivElement | null) => {
    garmentRoRef.current?.disconnect();
    garmentRoRef.current = null;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0;
      const count = Math.max(1, Math.floor((w + 20) / (108.8 + 20)));
      setGarmentVisibleCount(count);
    });
    ro.observe(el);
    garmentRoRef.current = ro;
  }, []);
```

Replace with:

```typescript
  const { visibleCount: garmentVisibleCount, rowRef: garmentRowRef } = useVisibleCount(108.8, 20);
```

Add the import near the top of `page.tsx` (alongside the other local imports):

```typescript
import { useVisibleCount } from './use-visible-count';
```

- [ ] **Step 3: Verify no other code referenced the removed `garmentRoRef`/`setGarmentVisibleCount` symbols**

Run: `grep -n "garmentRoRef\|setGarmentVisibleCount" apps/web/src/app/\(app\)/studio/page.tsx`
Expected: no matches (both were only used in the block just replaced).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: no new errors.

- [ ] **Step 5: Manual verification**

With `pnpm --filter @tryme/web dev` running, open `/studio`, resize the browser window, confirm the Garment Type row still shows the same number of cards as before (no visible behavior change).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/\(app\)/studio/use-visible-count.ts apps/web/src/app/\(app\)/studio/page.tsx
git commit -m "refactor(web): extract useVisibleCount hook from studio garment row"
```

---

### Task 2: Extract `SelectGridModal` component

**Files:**
- Create: `apps/web/src/app/(app)/studio/select-modal.tsx`

**Interfaces:**
- Produces: `SelectGridModal<T>` component with props:
  ```typescript
  interface SelectGridModalProps<T extends { id: string; label: string; thumbnailUrl?: string | null; previewUrl?: string | null }> {
    title: string;
    items: T[];
    selectedIds: string[];
    multiSelect?: boolean; // default false
    onSelect: (id: string) => void; // toggles selection; caller owns the state update
    onClose: () => void;
    cardWidth?: number; // default 136
    cardHeight?: number; // default 148
  }
  ```
  When `multiSelect` is `false` (default), calling `onSelect` is expected to also close the modal (the parent's `onSelect` callback is responsible for closing — this component never auto-closes itself, so both single- and multi-select callers share one implementation).
- Consumes: `C` from `@/components/tokens`, `CheckIcon`/`XIcon` from `@/components/icons` — both already used elsewhere in `page.tsx`, no new dependency.

- [ ] **Step 1: Create the component file**

```tsx
// apps/web/src/app/(app)/studio/select-modal.tsx
'use client';
import { CheckIcon, XIcon } from '@/components/icons';
import { C } from '@/components/tokens';

interface SelectableItem {
  id: string;
  label: string;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
}

interface SelectGridModalProps<T extends SelectableItem> {
  title: string;
  items: T[];
  selectedIds: string[];
  multiSelect?: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  cardWidth?: number;
  cardHeight?: number;
}

export function SelectGridModal<T extends SelectableItem>({
  title,
  items,
  selectedIds,
  multiSelect = false,
  onSelect,
  onClose,
  cardWidth = 136,
  cardHeight = 148,
}: SelectGridModalProps<T>) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: C.white,
          borderRadius: 12,
          padding: 24,
          width: 680,
          maxWidth: '90vw',
          maxHeight: '80vh',
          overflow: 'auto',
          boxShadow: '0 10px 40px rgba(0,0,0,0.15)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 20,
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: 0 }}>{title}</h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: C.mid,
            }}
          >
            <XIcon size={20} />
          </button>
        </div>
        {items.length === 0 ? (
          <p style={{ fontSize: 14, color: C.mid }}>Nothing available yet.</p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, ${cardWidth}px)`,
              gap: 16,
            }}
          >
            {items.map((item) => {
              const selected = selectedIds.includes(item.id);
              const img = item.previewUrl || item.thumbnailUrl;
              return (
                <div
                  key={item.id}
                  onClick={() => onSelect(item.id)}
                  style={{ cursor: 'pointer', textAlign: 'center' }}
                >
                  <div
                    style={{
                      width: cardWidth,
                      height: cardHeight,
                      borderRadius: 8,
                      overflow: 'hidden',
                      position: 'relative',
                      border: selected ? '2px solid transparent' : `2px solid ${C.border}`,
                      backgroundImage: selected
                        ? 'linear-gradient(90deg, #F55C7A 0%, #F6B553 100%)'
                        : 'none',
                      padding: selected ? 2 : 0,
                      boxSizing: 'border-box',
                    }}
                  >
                    <div
                      style={{
                        width: '100%',
                        height: '100%',
                        borderRadius: 6,
                        overflow: 'hidden',
                        background: C.lighter,
                      }}
                    >
                      {img ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={img}
                          alt={item.label}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            objectPosition: 'top center',
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            width: '100%',
                            height: '100%',
                            background: C.field,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: C.light,
                            fontSize: 11,
                          }}
                        >
                          {item.label}
                        </div>
                      )}
                    </div>
                    {selected && (
                      <div
                        style={{
                          position: 'absolute',
                          top: 6,
                          right: 6,
                          width: 20,
                          height: 20,
                          borderRadius: '50%',
                          background: 'linear-gradient(90deg, #F55C7A 0%, #F6B553 100%)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <CheckIcon color={C.white} size={11} />
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: C.text, marginTop: 8 }}>
                    {item.label}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: no errors (file is new and not yet imported anywhere, so this only checks the file compiles standalone).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(app\)/studio/select-modal.tsx
git commit -m "feat(web): add reusable SelectGridModal for studio view-more popups"
```

---

### Task 3: Replace the Garment Type modal with `SelectGridModal`

**Files:**
- Modify: `apps/web/src/app/(app)/studio/page.tsx:1813-1979` (the existing inline Garment Type modal JSX)

**Interfaces:**
- Consumes: `SelectGridModal` from `./select-modal` (Task 2).

- [ ] **Step 1: Add the import**

```typescript
import { SelectGridModal } from './select-modal';
```

- [ ] **Step 2: Replace the modal JSX block**

Delete the entire block from `{/* Garment Type Modal */}` through its closing `)}` (`page.tsx:1813-1979`) and replace with:

```tsx
      {/* Garment Type Modal */}
      {garmentModalOpen && garmentTypes && (
        <SelectGridModal
          title="Choose Garment Type"
          items={garmentTypes.items.map((s) => ({
            id: s.id,
            label: s.label,
            thumbnailUrl:
              s.thumbnailUrl ??
              (() => {
                const fallbackKey = Object.keys(OUTFIT_IMG).find(
                  (k) => s.slug.toLowerCase().includes(k) || s.label.toLowerCase().includes(k),
                );
                return fallbackKey ? OUTFIT_IMG[fallbackKey] : null;
              })(),
          }))}
          selectedIds={garmentTypeId ? [garmentTypeId] : []}
          onSelect={(id) => {
            const changed = id !== garmentTypeId;
            setGarmentTypeId(id);
            setGarmentModalOpen(false);
            if (changed) {
              setFaceId('');
              setBackgroundId('');
              setPoseIds([]);
              setLowerCatalogId('');
              setShoeCatalogId('');
            }
          }}
          onClose={() => setGarmentModalOpen(false)}
        />
      )}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: no errors.

- [ ] **Step 4: Manual verification**

In the browser, open `/studio`, narrow the window until the Garment Type row shows a "View more" link, click it, confirm the popup shows all garment types, confirm clicking one selects it, closes the modal, and resets dependent selections (face/background/poses) exactly as before.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\(app\)/studio/page.tsx
git commit -m "refactor(web): use SelectGridModal for studio garment-type popup"
```

---

### Task 4: Create the static `PreviewPanel` component

**Files:**
- Create: `apps/web/src/app/(app)/studio/preview-panel.tsx`

**Interfaces:**
- Produces: `PreviewPanel()` component, no props — purely static, matches the "studio" mode markup in `Two-page design frames/CatalogueScreen.dc.html` lines 196-225.
- Consumes: `C` from `@/components/tokens`.

- [ ] **Step 1: Create the component file**

```tsx
// apps/web/src/app/(app)/studio/preview-panel.tsx
'use client';
import { SparkleIcon } from '@/components/icons';
import { C } from '@/components/tokens';

const BENEFITS = ['No photoshoots required', 'No model coordination', 'No editing hassle'];

export function PreviewPanel() {
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
          padding: 16,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          justifyContent: 'center',
        }}
      >
        <span style={{ fontSize: 20, fontWeight: 600, color: C.text }}>
          Your Catalogue Preview
        </span>
        <span style={{ fontSize: 14, fontWeight: 500, color: C.mid }}>
          Generated images will appear here.
        </span>
      </div>
      <div style={{ flex: 1, padding: 16, boxSizing: 'border-box' }}>
        <div
          style={{
            height: '100%',
            borderRadius: 8,
            outline: `2px dashed ${C.border2}`,
            outlineOffset: -2,
            padding: 16,
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div
            style={{
              width: '100%',
              flex: 1,
              minHeight: 200,
              borderRadius: 8,
              background:
                'repeating-linear-gradient(135deg, rgb(245,245,246) 0 14px, rgb(239,239,241) 14px 28px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span style={{ fontFamily: 'monospace', fontSize: 12, color: C.light }}>
              generated preview
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              width: '100%',
              padding: '16px 8px 0',
              boxSizing: 'border-box',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
              <span
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  textAlign: 'center',
                  color: C.text,
                }}
              >
                From product photo to catalogue-ready visuals
              </span>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  textAlign: 'center',
                  color: C.mid,
                  maxWidth: 420,
                }}
              >
                Upload your product image, choose your preferences, and let AI create
                high-quality catalogue images that look professionally shot.
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
              {BENEFITS.map((b) => (
                <div key={b} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ color: C.pink, display: 'flex' }}>
                    <SparkleIcon size={15} />
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 500, color: C.text }}>{b}</span>
                </div>
              ))}
            </div>
          </div>
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              fontStyle: 'italic',
              textAlign: 'center',
              color: C.light,
              paddingTop: 16,
            }}
          >
            Preview your AI-generated output here before download.
          </span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: no errors. (If `SparkleIcon` doesn't accept a `size` prop, check `apps/web/src/components/icons.tsx` for its actual signature and adjust the call to match — every icon in this codebase takes a `size` prop per the existing `page.tsx` usages, e.g. `<SparkleIcon />`/`<CheckIcon color={C.white} size={11} />`, so this should already match.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(app\)/studio/preview-panel.tsx
git commit -m "feat(web): add static PreviewPanel component for studio redesign"
```

---

### Task 5: Add Model / Background / Pose inline rows + View More modals

**Files:**
- Modify: `apps/web/src/app/(app)/studio/page.tsx` (state additions near the existing `garmentVisibleCount` block, and the Step 1/Step 2/Step 3 section JSX)

**Interfaces:**
- Consumes: `useVisibleCount` (Task 1), `SelectGridModal` (Task 2).
- Produces: state `modelModalOpen`, `backgroundModalOpen`, `poseModalOpen` (all `boolean`), each paired with a `useVisibleCount` call — these are consumed by Task 6 when sections are unconditionally rendered.

- [ ] **Step 1: Add state and visible-count hooks**

Right after the `garmentRowRef` line added in Task 1, add:

```typescript
  const { visibleCount: modelVisibleCount, rowRef: modelRowRef } = useVisibleCount(215.2, 16);
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const { visibleCount: backgroundVisibleCount, rowRef: backgroundRowRef } = useVisibleCount(
    215.2,
    16,
  );
  const [backgroundModalOpen, setBackgroundModalOpen] = useState(false);
  const { visibleCount: poseVisibleCount, rowRef: poseRowRef } = useVisibleCount(215.2, 8);
  const [poseModalOpen, setPoseModalOpen] = useState(false);
```

- [ ] **Step 2: Rewrite the "Choose your model" section (`page.tsx:1431-1537`, the `step === 1` block)**

Replace the section's grid rendering (the part after the filter/search row, currently a `display: 'grid'` showing the full filtered list) with an inline row + View More link, matching the Garment Type section's header pattern:

```tsx
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 14,
            }}
          >
            <SectionHead title="Choose your model" />
            {filteredFaces.length > modelVisibleCount && (
              <button
                onClick={() => setModelModalOpen(true)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  height: 16,
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 12, color: '#626262' }}>View more</span>
              </button>
            )}
          </div>
          {facesError ? (
            <ErrorState
              compact
              title="Couldn't load models"
              message="There was a problem fetching models. Please try again."
              onRetry={() => refetchFaces()}
            />
          ) : !faces ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0', color: C.mid }}>
              <SpinnerIcon />
            </div>
          ) : (
            <div ref={modelRowRef} style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {filteredFaces.slice(0, modelVisibleCount).map((f) => (
                <SelCard
                  key={f.id}
                  selected={faceId === f.id}
                  onClick={() => handleFaceSelect(f.id)}
                  imageUrl={f.thumbnailUrl}
                  label={f.label}
                  w={215.2}
                  h={212.67}
                />
              ))}
            </div>
          )}
          {modelModalOpen && faces && (
            <SelectGridModal
              title="Choose your model"
              items={filteredFaces}
              selectedIds={faceId ? [faceId] : []}
              cardWidth={152.57}
              cardHeight={190}
              onSelect={(id) => {
                handleFaceSelect(id);
                setModelModalOpen(false);
              }}
              onClose={() => setModelModalOpen(false)}
            />
          )}
```

Keep the existing model-filter pill row and search input above this block unchanged — only the grid-rendering part (and the `SectionHead` line, now folded into the flex header) is replaced.

- [ ] **Step 3: Rewrite the "Select Background" section (`page.tsx:1540-1588`, the `step === 2` block)**

```tsx
        <section>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 14,
            }}
          >
            <SectionHead title="Select Background" />
            {(backgrounds?.items.length ?? 0) > backgroundVisibleCount && (
              <button
                onClick={() => setBackgroundModalOpen(true)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  height: 16,
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 12, color: '#626262' }}>View more</span>
              </button>
            )}
          </div>
          {backgroundsError ? (
            <ErrorState
              compact
              title="Couldn't load backgrounds"
              message="There was a problem fetching backgrounds. Please try again."
              onRetry={() => refetchBackgrounds()}
            />
          ) : !backgrounds ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0', color: C.mid }}>
              <SpinnerIcon />
            </div>
          ) : backgrounds.items.length === 0 ? (
            <p style={{ fontSize: 14, color: C.mid }}>
              No backgrounds available for this model yet. Try a different model.
            </p>
          ) : (
            <div ref={backgroundRowRef} style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {backgrounds.items.slice(0, backgroundVisibleCount).map((b) => (
                <SelCard
                  key={b.id}
                  selected={backgroundId === b.id}
                  onClick={() => handleBackgroundSelect(b.id)}
                  imageUrl={b.previewUrl || b.thumbnailUrl}
                  label={b.label}
                  w={215.2}
                  h={212.67}
                />
              ))}
            </div>
          )}
          {backgroundModalOpen && backgrounds && (
            <SelectGridModal
              title="Select Background"
              items={backgrounds.items}
              selectedIds={backgroundId ? [backgroundId] : []}
              cardWidth={152.57}
              cardHeight={150}
              onSelect={(id) => {
                handleBackgroundSelect(id);
                setBackgroundModalOpen(false);
              }}
              onClose={() => setBackgroundModalOpen(false)}
            />
          )}
        </section>
```

- [ ] **Step 4: Rewrite the "Choose Poses" section (`page.tsx:1591-1639`, inside the `step === 3` block)**

```tsx
        <section>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 14,
            }}
          >
            <SectionHead title="Choose Poses" />
            {(poses?.items.length ?? 0) > poseVisibleCount && (
              <button
                onClick={() => setPoseModalOpen(true)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  height: 16,
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 12, color: '#626262' }}>View more</span>
              </button>
            )}
          </div>
          {posesError ? (
            <ErrorState
              compact
              title="Couldn't load poses"
              message="There was a problem fetching poses. Please try again."
              onRetry={() => refetchPoses()}
            />
          ) : !poses ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0', color: C.mid }}>
              <SpinnerIcon />
            </div>
          ) : poses.items.length === 0 ? (
            <p style={{ fontSize: 14, color: C.mid }}>
              No poses for this combination. Try a different background.
            </p>
          ) : (
            <div ref={poseRowRef} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {poses.items.slice(0, poseVisibleCount).map((p) => (
                <SelCard
                  key={p.id}
                  selected={poseIds.includes(p.id)}
                  onClick={() => handlePoseSelect(p.id)}
                  imageUrl={p.thumbnailUrl}
                  label={p.label}
                  w={215.2}
                  h={282}
                />
              ))}
            </div>
          )}
          {poseModalOpen && poses && (
            <SelectGridModal
              title="Choose Poses"
              items={poses.items}
              selectedIds={poseIds}
              multiSelect
              cardWidth={152.57}
              cardHeight={200}
              onSelect={(id) => handlePoseSelect(id)}
              onClose={() => setPoseModalOpen(false)}
            />
          )}
        </section>
```

Note this section keeps the modal open after each click (multi-select, `onClose` only fires from the X button or backdrop click) — `handlePoseSelect` already toggles membership in `poseIds`, so re-clicking a selected pose in the modal deselects it, matching inline-row behavior.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: no errors.

- [ ] **Step 6: Manual verification**

In the browser: for each of Model, Background, Pose sections — narrow the window so "View more" appears, click it, verify the popup grid renders, verify single-select sections (Model, Background) close on click and select correctly, verify the Pose popup supports clicking multiple poses without closing and that toggling a selected pose off works both in the popup and the inline row.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/\(app\)/studio/page.tsx
git commit -m "feat(web): add inline+View More pattern to studio Model/Background/Pose sections"
```

---

### Task 6: Remove step state and step gating

**Files:**
- Modify: `apps/web/src/app/(app)/studio/page.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: page no longer has `step`/`visibleStep` state; later tasks (7, 8) assume these are gone.

- [ ] **Step 1: Remove step state and the resolution-default effect's step check**

Delete:

```typescript
  const [step, setStep] = useState(0); // 0..3
```

Replace:

```typescript
  useEffect(() => {
    if (step === 3 && !resolution) {
      setResolution('HD');
    }
  }, [step, resolution]);
```

with:

```typescript
  useEffect(() => {
    if (!resolution) {
      setResolution('HD');
    }
  }, [resolution]);
```

- [ ] **Step 2: Drop `step` from all React Query `enabled` flags**

In the `faces` query: change `enabled: !!gender && step >= 1,` to `enabled: !!gender,`
In the `backgrounds` query: change `enabled: !!gender && step >= 2,` to `enabled: !!gender,`
In the `poses` query: change `enabled: !!(gender && step >= 3),` to `enabled: !!gender,`
In the `lowerCatalog` query: change `enabled: step >= 3 && needsLower,` to `enabled: needsLower,`
In the `shoesCatalog` query: change `enabled: step >= 3 && needsShoes,` to `enabled: needsShoes,`

- [ ] **Step 3: Remove `step`-gated JSX wrappers**

Remove the `{step === 0 && (` / closing `)}` wrapper around the Step 0 section (keep its inner JSX, now rendered unconditionally — it becomes a sequence of sibling `<section>` elements directly inside the scroll container).
Remove the `{step === 1 && (` / `)}` wrapper around the model section, the `{step === 2 && (` / `)}` wrapper around the background section, and the `{step === 3 && (` / `)}` wrapper around the poses/lower/shoe block and the resolution block (these last two were two separate `step === 3 &&` blocks — unwrap both).

After unwrapping, the left column's section order (top to bottom) must read: Catalogue For → Garment Type → Publishing Platform/Aspect Ratio → Upload Garment Image(s) → Choose your model → Select Background → Choose Poses → Lower Garment (conditional) → Footwear (conditional) → Output Resolution. Reorder the unwrapped JSX blocks if needed to match — the current file has Upload Garment Image(s) listed after Publishing Platform/Aspect Ratio already, so no reordering should be necessary beyond removing the wrappers.

- [ ] **Step 4: Remove now-dead step-navigation helpers**

Delete `goNext`, `goBack`, `canNext`, `nextBlocker`, and `visibleStep` — none of these are referenced once step gating and the Back/Next footer (removed in Task 7) are gone. Confirm with a grep before deleting each:

Run: `grep -n "goNext\|goBack\|canNext\|nextBlocker\|visibleStep" apps/web/src/app/\(app\)/studio/page.tsx`

Delete every line that grep finds except the import of `StepBar` (handled in Task 7) and `ChevronRight`/`ArrowLeft` icon imports (also handled in Task 7).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: errors about unused `StepBar`/`ArrowLeft`/`ChevronRight` imports and the full-width footer's references to `goBack`/`step` are expected at this point — Task 7 removes the footer and its imports. If typecheck reports errors unrelated to those (e.g. a stray `step` reference inside a section you forgot to unwrap), fix those before proceeding.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/\(app\)/studio/page.tsx
git commit -m "refactor(web): remove step-wizard state, render all studio sections unconditionally"
```

---

### Task 7: Two-column layout — pinned left-column footer + right `PreviewPanel`

**Files:**
- Modify: `apps/web/src/app/(app)/studio/page.tsx`

**Interfaces:**
- Consumes: `PreviewPanel` from `./preview-panel` (Task 4).

- [ ] **Step 1: Add the import, remove dead imports**

Add:

```typescript
import { PreviewPanel } from './preview-panel';
```

Remove (now unused after Task 6 removed their only call sites):

```typescript
import { StepBar } from '@/components/step-indicator';
```

and remove `ArrowLeft`, `ChevronRight` from the icon import list at the top — check first with:

Run: `grep -n "ArrowLeft\|ChevronRight" apps/web/src/app/\(app\)/studio/page.tsx`

If either is still referenced elsewhere (it shouldn't be after Task 6 and this task), keep it; otherwise remove from the import line.

- [ ] **Step 2: Replace `<TopBar title="Create Catalogue" right={<StepBar step={visibleStep} />} />` with**

```tsx
      <TopBar title="Create Catalogue" />
```

- [ ] **Step 3: Wrap the scrollable content + footer in a left column, add the right column**

Find the outer scroll container (currently):

```tsx
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '24px 28px',
          display: 'flex',
          flexDirection: 'column',
          gap: 28,
        }}
      >
```

and its matching closing `</div>` right before the `{/* Garment Type Modal */}` comment (now a `SelectGridModal` call per Task 3). Wrap that whole scroll container plus the footer block (the `{/* Footer */}` div, currently full-width below the scroll container) inside a new flex row, with `PreviewPanel` as the second column:

```tsx
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 20, padding: '24px 28px' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              paddingRight: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 28,
            }}
          >
            {/* all the unconditional sections from Task 6 go here, unchanged */}
          </div>

          {/* Footer (pinned, left column only) */}
          <div
            style={{
              borderTop: `1px solid ${C.border}`,
              paddingTop: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              flexShrink: 0,
            }}
          >
            {submitError && (
              <div
                style={{
                  padding: '8px 14px',
                  borderRadius: 8,
                  border: `1px solid ${C.pink}`,
                  background: 'rgba(245,92,122,0.06)',
                  fontSize: 13,
                  color: C.pink,
                }}
              >
                {submitError}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {creditCost > 0 && (
                  <>
                    <span style={{ color: C.pink, display: 'flex' }}>
                      <SparkleIcon />
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 500, color: C.mid }}>
                      {creditCost} Credits Required to Generate
                    </span>
                  </>
                )}
              </div>
              <Tooltip tip={generateBlocker || undefined}>
                <GradBtn
                  onClick={handleSubmit}
                  disabled={!canGenerate}
                  style={{ padding: '10px 28px', gap: 8, fontSize: 15 }}
                >
                  {isSubmitting ? (
                    <>
                      <SpinnerIcon size={16} /> Generating…
                    </>
                  ) : isUploading ? (
                    <>
                      <SpinnerIcon size={16} /> Uploading…
                    </>
                  ) : (
                    <>
                      <SparkleIcon /> Create Catalogue
                    </>
                  )}
                </GradBtn>
              </Tooltip>
            </div>
          </div>
        </div>

        <div style={{ width: 480, flexShrink: 0 }}>
          <PreviewPanel />
        </div>
      </div>
```

Delete the old standalone `{/* Footer */}` block entirely (it's now folded into the structure above) — including its old `step === 3 && submitError` conditional (submitError is shown unconditionally now, since there's no step 3 to gate on) and the old nav row's Reset/Back/Next buttons.

- [ ] **Step 4: Remove now-dead helpers from the old footer**

Delete `reset()`, the `ghostBtn` style constant if no longer referenced, and confirm `DarkBtn` import is removed if no longer used:

Run: `grep -n "ghostBtn\|DarkBtn\|reset(" apps/web/src/app/\(app\)/studio/page.tsx`

Remove any import or declaration that the grep shows has zero remaining call sites.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: no errors.

- [ ] **Step 6: Lint**

Run: `pnpm --filter @tryme/web lint`
Expected: no errors (fix any unused-import warnings Biome reports).

- [ ] **Step 7: Manual verification**

In the browser, open `/studio`:
- Confirm two columns render: left form (scrollable), right static `PreviewPanel` (matches the mockup's empty-state copy/illustration).
- Confirm the Generate button + credit text sit at the bottom of the left column only, not spanning the full page width.
- Confirm there is no step indicator / Back / Next / Reset anywhere.
- Walk through a full submission: select gender → garment type → upload garment (and lower garment if the type requires it) → platform/aspect → model → background → poses (and lower/footwear if applicable) → resolution → click Generate → confirm redirect to `/catalogues/{id}`.
- If platform is Amazon with "Main listing" and multiple poses selected, confirm the Amazon pose-picker modal still appears and both jobs submit correctly.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/\(app\)/studio/page.tsx
git commit -m "feat(web): single-page studio layout with sticky preview panel and pinned generate footer"
```

---

### Task 8: Final full-flow regression pass

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Full regression walk per the spec's Testing section**

With `pnpm --filter @tryme/web dev` running, verify each item from `docs/superpowers/specs/2026-06-17-studio-single-page-design.md`'s Testing section:
1. All sections visible on page load without clicking "Next."
2. Garment Type / Model / Background / Pose: inline row count adapts to viewport width; "View More" opens the correct popup; pose popup supports multi-select without auto-closing.
3. Gender change clears garment type/model/background/poses; garment type change clears model/background/poses; model change clears background/poses; background change clears poses/lower/shoe.
4. Lower Garment / Footwear sections appear only when `needsLower`/`needsShoes` are true for the currently selected poses.
5. Generate button disabled + tooltip states match prior blockers: no garment uploaded, no poses selected, no resolution selected, upload in progress.
6. Amazon main-listing multi-pose flow still opens the picker and submits both the white-bg main job and the remaining-poses job.
7. Successful generate redirects to `/catalogues/{catalogueId}`.
8. Right panel renders the static content from the mockup regardless of any form state changes.

- [ ] **Step 2: Run full web typecheck + lint one more time**

Run: `pnpm --filter @tryme/web typecheck && pnpm --filter @tryme/web lint`
Expected: both pass clean.

- [ ] **Step 3: Report results to the user**

Summarize pass/fail for each of the 8 checks above before considering this plan complete. Do not commit anything in this task — it's verification-only.
