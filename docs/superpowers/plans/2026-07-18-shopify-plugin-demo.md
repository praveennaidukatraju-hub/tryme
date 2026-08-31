# Shopify Catalogue Plugin Demo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working, fully-functional mock inside `apps/catalogues-web` at `/shopify-plugin` that shows how the Ai Vastra catalogue plugin would embed into a merchant's real Shopify "Add product" page — clicking a branded tile in the Media grid opens a real, same-origin `<iframe>` running a condensed Studio generation wizard; a real AI-generated result can be explicitly dropped back into the mocked Media grid.

**Architecture:** A static, non-interactive replica of Shopify's "Add product" screen (`apps/catalogues-web/src/app/(app)/shopify-plugin/`) with one live surface — a Media grid — that opens a modal containing a real `<iframe src="/embed/shopify-plugin-studio">`. That route lives in a new `apps/catalogues-web/src/app/embed/` route group with no Ai Vastra chrome (no Sidebar/TopBar), running a condensed version of the Studio wizard against the same real backend endpoints Studio itself uses. The iframe and parent communicate via `window.postMessage`.

**Tech Stack:** Next.js 15 (App Router), React 19, `@tanstack/react-query` 5, TypeScript 5.6, inline-style components matching the existing `apps/catalogues-web` convention (no Tailwind classes despite it being installed — this codebase does not use it).

## Global Constraints

- Read `docs/superpowers/specs/2026-07-18-shopify-plugin-demo-design.md` first — it is the source of truth for scope decisions this plan implements mechanically.
- No new dependencies. Everything needed (`lucide-react`, `@tanstack/react-query`, existing icon/token modules) is already installed.
- Follow the codebase's inline-`style={{}}` convention, not Tailwind classes — match `apps/catalogues-web/src/app/(app)/studio/page.tsx`'s style.
- Ai Vastra's own UI elements (buttons, badges, the wizard) must use the `C`/`grad` tokens from `@/components/tokens` — never raw hex — per `CLAUDE.md`'s Design Tokens rule. This applies to any *new* color decision this plan makes: e.g. error text must use `C.pink` (the codebase's own established convention — see `apps/catalogues-web/src/app/(app)/studio/page.tsx`'s `submitError` block), never an invented hex like `#d33`.
- **Two narrower, pre-existing exceptions, not a general license for new hex:**
  1. **Shopify chrome.** The static Shopify chrome (top bar, left nav rail, form fields, Inventory/Shipping/Variants sections) mimics a *foreign product's* visual identity (Shopify's own gray/black palette), which has no entry in `tokens.ts` and never should. Literal hex values (e.g. `#1a1a1a`, `#c9cccf`, `#8a8a8a`) are correct and intentional **only** inside `apps/catalogues-web/src/app/(app)/shopify-plugin/shopify-plugin-demo.tsx` and `shopify-mock-data.ts`.
  2. **Reused Studio gradients.** `tokens.ts` has no entries for the specific gradient stop-pairs Studio already hardcodes throughout `page.tsx` and `generation-panel.tsx` (e.g. `#BD2587 0%, #ff5b94 100%` for selection highlights, `#521D9C 0%, #754AB0 100%` for the processing/results accent). Task 1 extracts that existing code verbatim, and Tasks 2/5/6 intentionally reuse those exact same stop-pairs so the embedded wizard and its "Use this image" affordance look like they belong to Studio. This is fine — do not replace them with `C.pink`/`grad` (which render a different gradient) or invent a third variant. **Never introduce a new hex value not already used by Studio's existing code** — that is what exception (1) and the `C.pink` sentence above rule out.
- `/embed/*` must stay behind the existing cookie-auth check in `apps/catalogues-web/src/middleware.ts` — do **not** add it to `PUBLIC_PATHS`.
- No backend/API changes. Every network call this plan makes already exists and is used by `apps/catalogues-web/src/app/(app)/studio/page.tsx` today.
- `apps/catalogues-web` has no unit/integration test runner (see `CLAUDE.md`'s Testing Architecture section — only `apps/api` and `apps/dispatcher` have one). Each task's "test" step is: `pnpm --filter @tryme/web typecheck`, `pnpm --filter @tryme/web lint`, and a manual check against a running `pnpm --filter @tryme/web dev` server, per `CLAUDE.md`'s explicit guidance for frontend changes.
- Commit after each task with `git add <files>` + `git commit` (no `--no-verify`).

---

## Task 1: Extract shared presentational cards out of the Studio page

`studio/page.tsx` defines `GenderCard`, `SelCard`, `SectionHead`, and `sectionCardStyle` as local, non-exported functions. The embedded wizard (Task 5/6) needs the exact same visual components so the demo looks like it's genuinely using Studio. Rather than duplicate ~370 lines of styled markup (which would drift out of sync), extract these four **pure, props-only** definitions into a new shared file and import them back into `studio/page.tsx`. This is a mechanical move with no behavior change — verify by confirming `/studio` still renders identically afterward.

**Files:**
- Create: `apps/catalogues-web/src/app/(app)/studio/shared-cards.tsx`
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx`

**Interfaces:**
- Produces (used by Task 5/6 and by `page.tsx` itself):
  - `GenderCard(props: { selected: boolean; onClick: () => void; img: string | null; label: string }): JSX.Element`
  - `SelCard<T>(props: { selected: boolean; onClick: () => void; imageUrl?: string | null; label?: string; w?: number | string; h?: number; ratio?: number; badges?: React.ReactNode; emptyContent?: React.ReactNode; borderWidth?: number; fillHeight?: boolean; imageObjectPosition?: string }): JSX.Element`
  - `SectionHead(props: { title: string; subtitle?: string; stepNumber?: number; titleSuffix?: React.ReactNode; right?: React.ReactNode }): JSX.Element`
  - `sectionCardStyle: React.CSSProperties`

- [ ] **Step 1: Create `shared-cards.tsx` with the four extracted definitions**

```tsx
'use client';
import { CheckIcon } from '@/components/icons';
import { C } from '@/components/tokens';

// ── Gender card — horizontal landscape layout (SVG/PNG spec: Frame 446) ──
// border-image + border-radius are incompatible in CSS; gradient border is
// achieved via a 1px gradient-background wrapper (same visual result).
export function GenderCard({
  selected,
  onClick,
  img,
  label,
}: {
  selected: boolean;
  onClick: () => void;
  img: string | null;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="gender-card-hover"
      style={{
        cursor: 'pointer',
        background: selected
          ? `linear-gradient(${C.card}, ${C.card}) padding-box, linear-gradient(135deg, #BD2587 0%, #ff5b94 100%) border-box`
          : `linear-gradient(${C.card}, ${C.card}) padding-box, linear-gradient(${C.border}, ${C.border}) border-box`,
        border: '1.5px solid transparent',
        borderRadius: 12,
        padding: 0,
        boxShadow: selected ? '0px 2px 10px rgba(189, 37, 135, 0.1)' : 'none',
        height: 72,
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        textAlign: 'left',
        transition: 'box-shadow 0.2s, transform 0.2s',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: selected
            ? 'linear-gradient(135deg, rgba(189,37,135,0.06) 0%, rgba(255,91,148,0.04) 100%)'
            : C.card,
          borderRadius: 10,
          padding: '0 12px',
          position: 'relative',
          height: '100%',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            flexShrink: 0,
            width: 40,
            height: 40,
            borderRadius: '50%',
            overflow: 'hidden',
            background: C.lighter,
            boxSizing: 'border-box',
          }}
        >
          {img && (
            // eslint-disable-next-line @next/next/no-img-element
            // biome-ignore lint/performance/noImgElement: small UI thumbnail, Next Image not needed
            <img
              src={img}
              alt={label}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'top center',
                transform: 'scale(1.35)',
                transformOrigin: 'center 5%',
              }}
            />
          )}
        </div>

        <span
          style={{
            fontFamily: 'Poppins, sans-serif',
            fontWeight: 600,
            fontSize: 14,
            lineHeight: '18px',
            letterSpacing: 0,
            color: C.text,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>

        {selected && (
          <div
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #BD2587 0%, #ff5b94 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CheckIcon color={C.white} size={11} />
          </div>
        )}
      </div>
    </button>
  );
}

// ── Selection card (model / bg / pose / catalog) ──
export function SelCard({
  selected,
  onClick,
  imageUrl,
  label,
  w = 130,
  h = 170,
  ratio,
  badges,
  emptyContent,
  borderWidth,
  fillHeight,
  imageObjectPosition = 'center',
}: {
  selected: boolean;
  onClick: () => void;
  imageUrl?: string | null;
  label?: string;
  w?: number | string;
  h?: number;
  ratio?: number;
  badges?: React.ReactNode;
  emptyContent?: React.ReactNode;
  borderWidth?: number;
  fillHeight?: boolean;
  imageObjectPosition?: string;
}) {
  const fluid = typeof w === 'string';
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: preview tile; parent button handles keyboard a11y
    <div
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick?.();
      }}
      className="garment-card"
      style={{
        cursor: 'pointer',
        textAlign: 'center',
        flexShrink: 0,
        width: typeof w === 'string' ? '100%' : w,
        background: selected
          ? `linear-gradient(${C.card}, ${C.card}) padding-box, linear-gradient(135deg, #BD2587 0%, #ff5b94 100%) border-box`
          : `linear-gradient(${C.card}, ${C.card}) padding-box, linear-gradient(${C.border}, ${C.border}) border-box`,
        border: `${borderWidth ?? 1.5}px solid transparent`,
        borderRadius: 12,
        padding: 0,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        transition: 'box-shadow 0.2s, transform 0.2s',
        boxShadow: selected ? '0px 2px 10px rgba(189, 37, 135, 0.1)' : 'none',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: 10,
          background: C.card,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          overflow: 'hidden',
        }}
      >
        <div
          className="sel-card-image"
          style={{
            width: '100%',
            aspectRatio: fluid && !fillHeight ? ratio : undefined,
            flex: fillHeight ? 1 : undefined,
            height: fluid ? undefined : h - 30,
            borderRadius: fillHeight ? 10 : '10px 10px 0 0',
            overflow: 'hidden',
            position: 'relative',
            background: C.lighter,
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              borderRadius: fillHeight ? 10 : '10px 10px 0 0',
              overflow: 'hidden',
              background: C.lighter,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {imageUrl ? (
              <div data-zoom style={{ width: '100%', height: '100%', transition: 'transform .3s' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {/* biome-ignore lint/performance/noImgElement: small selection card thumbnail */}
                <img
                  src={imageUrl}
                  alt={label}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    objectPosition: imageObjectPosition,
                  }}
                />
              </div>
            ) : emptyContent ? (
              emptyContent
            ) : (
              <span
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: C.mid,
                  textTransform: 'uppercase',
                  lineHeight: 1,
                }}
              >
                {label?.charAt(0)}
              </span>
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
                background: 'linear-gradient(135deg, #BD2587 0%, #ff5b94 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 2,
              }}
            >
              <CheckIcon color="#fff" size={11} />
            </div>
          )}
          {badges}
        </div>
        {label && (
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: C.text,
              padding: '8px 4px 6px',
              width: '100%',
              textAlign: 'center',
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
            }}
          >
            {label}
          </div>
        )}
      </div>
    </div>
  );
}

export function SectionHead({
  title,
  subtitle,
  stepNumber,
  titleSuffix,
  right,
}: {
  title: string;
  subtitle?: string;
  stepNumber?: number;
  titleSuffix?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
        position: 'relative',
        width: '100%',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {stepNumber && (
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #BD2587 0%, #ff5b94 100%)',
              color: '#FFFFFF',
              fontSize: 13,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {stepNumber}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h3
            style={{
              fontWeight: 600,
              fontSize: 15,
              color: C.text,
              margin: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {title}
            {titleSuffix}
          </h3>
          {subtitle && <span style={{ fontSize: 11, color: C.mid }}>{subtitle}</span>}
        </div>
      </div>
      {right}
    </div>
  );
}

export const sectionCardStyle: React.CSSProperties = {
  background: C.card,
  borderRadius: 16,
  border: `1px solid ${C.border}`,
  boxShadow: '0 4px 12px rgba(0,0,0,0.03)',
  padding: '24px 20px',
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  boxSizing: 'border-box',
};
```

- [ ] **Step 2: Remove the now-duplicated definitions from `page.tsx`**

In `apps/catalogues-web/src/app/(app)/studio/page.tsx`, delete the entire block starting at the comment `// ── Gender card — horizontal landscape layout (SVG/PNG spec: Frame 446) ──` and ending at the closing `};` of `sectionCardStyle` (this spans from the `GenderCard` function through `SelCard`, `SectionHead`, and `sectionCardStyle` — everything between the end of `VisualCard` and the start of the `// ── Garment upload tips — hover popover ──` comment). Leave `VisualCard`, `pill`, `AspectRatioIcon`, and `TagBadge` untouched — they are not needed by the embedded wizard and stay local to `page.tsx`.

- [ ] **Step 3: Add the import in `page.tsx`**

Find this existing import block near the top of `page.tsx`:

```tsx
import { CheckIcon, ImagePlusIcon, SparkleIcon, SpinnerIcon, XIcon } from '@/components/icons';
import { C, grad } from '@/components/tokens';
```

Add a new import line directly after it:

```tsx
import { GenderCard, SectionHead, SelCard, sectionCardStyle } from './shared-cards';
```

- [ ] **Step 4: Verify the extraction is behavior-neutral**

Run:
```bash
pnpm --filter @tryme/web typecheck
```
Expected: PASS, no errors about undefined `GenderCard`/`SelCard`/`SectionHead`/`sectionCardStyle` and no duplicate-declaration errors.

Run:
```bash
pnpm --filter @tryme/web dev
```
Open `/studio` in a browser while logged in. Confirm: gender cards, garment-type/face/background/pose selection cards, and section headers render exactly as before (same gradients, same layout, same click behavior). This is a pure move — if anything looks different, the extraction introduced a bug; fix it before continuing.

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/studio/shared-cards.tsx apps/catalogues-web/src/app/\(app\)/studio/page.tsx
git commit -m "refactor(web): extract shared Studio selection cards into shared-cards.tsx"
```

---

## Task 2: Add additive `onUseImage` / `hideCatalogueLink` props to `GenerationPanel`

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/generation-panel.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 6):
  - `GenerationPanelProps.onUseImage?: (args: { url: string; jobId: string; poseLabel: string }) => void`
  - `GenerationPanelProps.hideCatalogueLink?: boolean`

- [ ] **Step 1: Extend the props interface**

Find:
```tsx
export interface GenerationPanelProps {
  catalogueId: string;
  jobs: GenerationJob[];
  garmentPreviewUrl?: string;
  /** Called once when every job in this batch reaches a terminal status. */
  onAllSettled?: () => void;
  onCancel?: () => void;
}
```
Replace with:
```tsx
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
}
```

- [ ] **Step 2: Destructure the new props**

Find:
```tsx
export function GenerationPanel({
  catalogueId,
  jobs,
  garmentPreviewUrl,
  onAllSettled,
  onCancel,
}: GenerationPanelProps) {
```
Replace with:
```tsx
export function GenerationPanel({
  catalogueId,
  jobs,
  garmentPreviewUrl,
  onAllSettled,
  onCancel,
  onUseImage,
  hideCatalogueLink,
}: GenerationPanelProps) {
```

- [ ] **Step 3: Add the "Use this image" button to the hero preview**

Find (inside the `currentCompleted && currentResultUrl` branch of the Column 3 "Preview Output" block):
```tsx
                  <div
                    style={{ position: 'absolute', right: 8, bottom: 8, display: 'flex', gap: 6 }}
                  >
                    <a
                      href={currentResultUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 8,
                        background: C.card,
                        boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
                        border: `1px solid ${C.border}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: C.text,
                      }}
                    >
                      <FullscreenIcon />
                    </a>
                  </div>
```
Replace with:
```tsx
                  <div
                    style={{ position: 'absolute', right: 8, bottom: 8, display: 'flex', gap: 6 }}
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
                    <a
                      href={currentResultUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 8,
                        background: C.card,
                        boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
                        border: `1px solid ${C.border}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: C.text,
                      }}
                    >
                      <FullscreenIcon />
                    </a>
                  </div>
```

- [ ] **Step 4: Add the "Use this image" button to each grid tile**

Find (inside the results grid map, right after the download button's closing `</button>`, still inside the image-section `<div>`):
```tsx
                  <button
                    type="button"
                    disabled={!isCompleted || !resultUrl}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (resultUrl) downloadImage(resultUrl, job.id);
                    }}
                    style={{
                      position: 'absolute',
                      top: 8,
                      right: 8,
                      background: 'rgba(255, 255, 255, 0.85)',
                      backdropFilter: 'blur(4px)',
                      border: 'none',
                      borderRadius: '50%',
                      width: 28,
                      height: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: isCompleted && resultUrl ? 'pointer' : 'not-allowed',
                      opacity: isCompleted && resultUrl ? 1 : 0.45,
                      color: '#141414',
                      boxShadow: '0 2px 6px rgba(0,0,0,0.1)',
                      zIndex: 2,
                    }}
                  >
                    <DownloadIcon size={14} />
                  </button>
                </div>
```
Replace with:
```tsx
                  <button
                    type="button"
                    disabled={!isCompleted || !resultUrl}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (resultUrl) downloadImage(resultUrl, job.id);
                    }}
                    style={{
                      position: 'absolute',
                      top: 8,
                      right: 8,
                      background: 'rgba(255, 255, 255, 0.85)',
                      backdropFilter: 'blur(4px)',
                      border: 'none',
                      borderRadius: '50%',
                      width: 28,
                      height: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: isCompleted && resultUrl ? 'pointer' : 'not-allowed',
                      opacity: isCompleted && resultUrl ? 1 : 0.45,
                      color: '#141414',
                      boxShadow: '0 2px 6px rgba(0,0,0,0.1)',
                      zIndex: 2,
                    }}
                  >
                    <DownloadIcon size={14} />
                  </button>
                  {onUseImage && isCompleted && resultUrl && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUseImage({ url: resultUrl, jobId: job.id, poseLabel: job.label });
                      }}
                      style={{
                        position: 'absolute',
                        left: 8,
                        right: 8,
                        bottom: 8,
                        height: 26,
                        borderRadius: 8,
                        background: 'linear-gradient(135deg, #521D9C 0%, #754AB0 100%)',
                        color: '#fff',
                        border: 'none',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
                        zIndex: 2,
                      }}
                    >
                      Use this image
                    </button>
                  )}
                </div>
```

- [ ] **Step 5: Hide the catalogue link when `hideCatalogueLink` is set**

Find:
```tsx
      <Link
        href={`/catalogues/${catalogueId}`}
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
    </div>
  );
}
```
Replace with:
```tsx
      {!hideCatalogueLink && (
        <Link
          href={`/catalogues/${catalogueId}`}
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
  );
}
```

- [ ] **Step 6: Verify**

Run:
```bash
pnpm --filter @tryme/web typecheck
pnpm --filter @tryme/web lint
```
Expected: both PASS.

Open `/studio`, run one real generation (any garment/model/pose combination), and confirm the results panel looks and behaves **exactly** as before — no "Use this image" button appears (since Studio never passes `onUseImage`), and "View full catalogue →" still shows (since Studio never passes `hideCatalogueLink`). This confirms the change is additive-only.

- [ ] **Step 7: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/studio/generation-panel.tsx
git commit -m "feat(web): add optional onUseImage/hideCatalogueLink props to GenerationPanel"
```

---

## Task 3: Shared postMessage protocol module

**Files:**
- Create: `apps/catalogues-web/src/lib/shopify-plugin-embed-protocol.ts`

**Interfaces:**
- Produces (used by Task 6 inside the iframe, and Task 8 in the parent page):
  - `EMBED_IMAGE_SELECTED: 'tryme:image-selected'`
  - `interface EmbedImageSelectedMessage { type: typeof EMBED_IMAGE_SELECTED; imageUrl: string; jobId: string; poseLabel: string }`
  - `isEmbedImageSelectedMessage(data: unknown): data is EmbedImageSelectedMessage`
  - `postImageSelectedToParent(msg: { imageUrl: string; jobId: string; poseLabel: string }): void`

- [ ] **Step 1: Write the module**

```ts
// Shared contract for the postMessage channel between the Shopify-plugin demo
// page (parent, apps/catalogues-web .../shopify-plugin/shopify-plugin-demo.tsx)
// and the embedded generation wizard it loads in a same-origin <iframe>
// (apps/catalogues-web/src/app/embed/shopify-plugin-studio/). Both sides must
// stay in lockstep with this shape — import it, never hand-roll the message.

export const EMBED_IMAGE_SELECTED = 'tryme:image-selected' as const;

export interface EmbedImageSelectedMessage {
  type: typeof EMBED_IMAGE_SELECTED;
  imageUrl: string;
  jobId: string;
  poseLabel: string;
}

export function isEmbedImageSelectedMessage(data: unknown): data is EmbedImageSelectedMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === EMBED_IMAGE_SELECTED &&
    typeof msg.imageUrl === 'string' &&
    typeof msg.jobId === 'string' &&
    typeof msg.poseLabel === 'string'
  );
}

/** Call from inside the embedded iframe when the merchant confirms a result. */
export function postImageSelectedToParent(msg: {
  imageUrl: string;
  jobId: string;
  poseLabel: string;
}): void {
  const payload: EmbedImageSelectedMessage = { type: EMBED_IMAGE_SELECTED, ...msg };
  window.parent.postMessage(payload, window.location.origin);
}
```

- [ ] **Step 2: Verify**

Run:
```bash
pnpm --filter @tryme/web typecheck
```
Expected: PASS (this file has no external dependents yet, so this just confirms it's syntactically/type valid on its own).

- [ ] **Step 3: Commit**

```bash
git add apps/catalogues-web/src/lib/shopify-plugin-embed-protocol.ts
git commit -m "feat(web): add postMessage contract for the Shopify-plugin embed iframe"
```

---

## Task 4: `/embed` route group + stub wizard page

Creates the iframe target route with no Ai Vastra chrome, and confirms it loads correctly (auth, SSE provider) before building real wizard logic on top of it in Tasks 5–6.

**Files:**
- Create: `apps/catalogues-web/src/app/embed/layout.tsx`
- Create: `apps/catalogues-web/src/app/embed/shopify-plugin-studio/page.tsx`
- Create: `apps/catalogues-web/src/app/embed/shopify-plugin-studio/embed-studio-wizard.tsx` (stub — replaced in Task 5)

**Interfaces:**
- Produces (consumed by Task 5, which replaces the stub body): `export function EmbedStudioWizard(): React.ReactElement`

- [ ] **Step 1: Write the embed layout**

```tsx
import { JobStreamProvider } from '@/components/job-stream-provider';
import { C } from '@/components/tokens';

// No Sidebar/TopBar/ChatWidget/ProfileGate here — this route group renders
// full-bleed inside a same-origin <iframe> hosted by /shopify-plugin. It still
// needs JobStreamProvider because the embedded wizard's GenerationPanel
// subscribes to job-status SSE events via useJobStream.
export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <JobStreamProvider>
      <div style={{ minHeight: '100vh', background: C.white, boxSizing: 'border-box' }}>
        {children}
      </div>
    </JobStreamProvider>
  );
}
```

- [ ] **Step 2: Write the stub wizard component**

```tsx
'use client';

export function EmbedStudioWizard() {
  return <div style={{ padding: 24, fontFamily: 'inherit' }}>Wizard loading…</div>;
}
```

- [ ] **Step 3: Write the page**

```tsx
import { EmbedStudioWizard } from './embed-studio-wizard';

export const metadata = {
  title: 'Generate with Ai Vastra',
};

export default function ShopifyPluginStudioEmbedPage() {
  return <EmbedStudioWizard />;
}
```

- [ ] **Step 4: Verify the route loads behind auth**

Run:
```bash
pnpm --filter @tryme/web typecheck
pnpm --filter @tryme/web dev
```
While logged in (any existing session/tab), navigate directly to `http://localhost:3000/embed/shopify-plugin-studio`. Expected: page loads with **no** sidebar/topbar, showing only "Wizard loading…". Then open an incognito/logged-out window and hit the same URL — expected: redirected to `/login?next=/embed/shopify-plugin-studio` (proves `middleware.ts` still gates this route, since it was never added to `PUBLIC_PATHS`).

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/app/embed/
git commit -m "feat(web): add /embed route group for the Shopify-plugin iframe target"
```

---

## Task 5: `EmbedStudioWizard` — gender, garment type, garment upload

Replaces the Task 4 stub with the first three real wizard steps.

**Files:**
- Modify: `apps/catalogues-web/src/app/embed/shopify-plugin-studio/embed-studio-wizard.tsx`

**Interfaces:**
- Consumes: `GenderCard`, `SectionHead`, `sectionCardStyle` from `@/app/(app)/studio/shared-cards` (Task 1); `api` from `@/lib/api`.
- Produces (extended in Task 6, which appends face/background/pose/generate to this same file): local state `gender`, `garmentTypeId`, `garmentFile`, `garmentKey`, `isUploading`, `uploadProgress`, `uploadError` — Task 6 reads `garmentTypeId` and `garmentKey` to build the submit payload.

- [ ] **Step 1: Write the component**

```tsx
'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { SpinnerIcon } from '@/components/icons';
import { GenderCard, SectionHead, sectionCardStyle } from '@/app/(app)/studio/shared-cards';
import { C } from '@/components/tokens';
import { api } from '@/lib/api';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const GENDERS = [
  { value: 'women', label: 'Women', img: `${BASE}/assets/seg-women.png` },
  { value: 'men', label: 'Men', img: `${BASE}/assets/seg-men.png` },
  { value: 'boys', label: 'Boy', img: `${BASE}/assets/seg-boy.png` },
  { value: 'girls', label: 'Girl', img: `${BASE}/assets/seg-girl.png` },
];

// A subset of the fields Studio's GarmentType carries — this demo only
// supports plain single-upload garment types (see the design spec's Scope
// Boundaries section), so mannequin/dual-upload types are filtered out below.
interface EmbedGarmentType {
  id: string;
  label: string;
  thumbnailUrl?: string | null;
  requiresLowerUpload: boolean;
  requiresThirdUpload?: boolean;
  requiresMannequinStep?: boolean;
  defaultLowerCatalogId?: string | null;
  defaultShoeCatalogId?: string | null;
}

async function isSupportedImageBytes(file: File): Promise<boolean> {
  const buf = await file.slice(0, 12).arrayBuffer();
  const b = new Uint8Array(buf);
  const isJpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const isPng =
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a;
  const isWebp =
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50;
  return isJpeg || isPng || isWebp;
}

export function EmbedStudioWizard() {
  const [gender, setGender] = useState('women');
  const [garmentTypeId, setGarmentTypeId] = useState('');
  const [garmentFile, setGarmentFile] = useState<File | null>(null);
  const [garmentKey, setGarmentKey] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');

  const garmentPreviewUrl = useMemo(
    () => (garmentFile ? URL.createObjectURL(garmentFile) : ''),
    [garmentFile],
  );
  useEffect(() => {
    return () => {
      if (garmentPreviewUrl) URL.revokeObjectURL(garmentPreviewUrl);
    };
  }, [garmentPreviewUrl]);

  const { data: garmentTypesData } = useQuery<{ items: EmbedGarmentType[] }>({
    queryKey: ['embed-garment-types', gender],
    queryFn: () => api.get(`/v1/models/garment-types?gender=${gender}`),
  });
  const garmentTypes = useMemo(
    () =>
      (garmentTypesData?.items ?? []).filter(
        (g) => !g.requiresMannequinStep && !g.requiresLowerUpload && !g.requiresThirdUpload,
      ),
    [garmentTypesData],
  );
  const didAutoGarmentType = useMemo(() => ({ current: '' }), []);
  useEffect(() => {
    if (garmentTypes.length && !garmentTypeId && didAutoGarmentType.current !== gender) {
      setGarmentTypeId(garmentTypes[0]?.id ?? '');
      didAutoGarmentType.current = gender;
    }
  }, [garmentTypes, garmentTypeId, gender, didAutoGarmentType]);

  function handleGenderSelect(value: string) {
    setGender(value);
    setGarmentTypeId('');
  }

  async function handleGarmentUpload(file: File) {
    if (isUploading) return;
    if (file.size > 10 * 1024 * 1024) {
      setUploadError('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      setUploadError('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setUploadError('');
    setGarmentFile(file);
    setIsUploading(true);
    setUploadProgress(0);
    try {
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        expiresIn: number;
      }>('/v1/uploads/presign', { contentType: file.type, contentLength: file.size });
      await api.uploadToR2WithProgress(uploadUrl, file, setUploadProgress);
      setGarmentKey(r2Key);
    } catch (e) {
      setUploadError(`Upload failed: ${(e as Error).message}`);
      setGarmentFile(null);
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '24px 20px 40px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>
          Generate a product photo with Ai Vastra
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: C.mid }}>
          Every step below calls our real generation pipeline — the result is a genuine AI photo,
          not a placeholder.
        </p>
      </div>

      <div style={sectionCardStyle}>
        <SectionHead title="Who is this product for?" stepNumber={1} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
          {GENDERS.map((g) => (
            <GenderCard
              key={g.value}
              selected={gender === g.value}
              onClick={() => handleGenderSelect(g.value)}
              img={g.img}
              label={g.label}
            />
          ))}
        </div>
      </div>

      <div style={sectionCardStyle}>
        <SectionHead title="Garment type" stepNumber={2} />
        {garmentTypes.length === 0 ? (
          <span style={{ fontSize: 13, color: C.mid }}>Loading garment types…</span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {garmentTypes.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setGarmentTypeId(g.id)}
                style={{
                  cursor: 'pointer',
                  padding: '8px 14px',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  border: `1.5px solid ${g.id === garmentTypeId ? C.pink : C.border2}`,
                  background: g.id === garmentTypeId ? 'rgba(189,37,135,0.08)' : C.white,
                  color: g.id === garmentTypeId ? C.pink : C.text,
                }}
              >
                {g.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={sectionCardStyle}>
        <SectionHead title="Upload the garment photo" stepNumber={3} />
        <label
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            height: 160,
            border: `1.5px dashed ${C.border2}`,
            borderRadius: 12,
            cursor: 'pointer',
            overflow: 'hidden',
            position: 'relative',
            background: C.lighter,
          }}
        >
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleGarmentUpload(file);
            }}
          />
          {garmentPreviewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={garmentPreviewUrl}
              alt="Garment"
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          ) : (
            <>
              <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                Click to choose a garment photo
              </span>
              <span style={{ fontSize: 11, color: C.mid }}>JPEG, PNG, or WebP — up to 10 MB</span>
            </>
          )}
          {isUploading && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(255,255,255,0.75)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                fontSize: 12,
                fontWeight: 600,
                color: C.pink,
              }}
            >
              <SpinnerIcon size={16} /> Uploading… {uploadProgress}%
            </div>
          )}
        </label>
        {uploadError && (
          <span style={{ fontSize: 12, color: C.pink, marginTop: 8 }}>{uploadError}</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run:
```bash
pnpm --filter @tryme/web typecheck
pnpm --filter @tryme/web lint
```
Expected: both PASS.

With `pnpm --filter @tryme/web dev` running, visit `/embed/shopify-plugin-studio` while logged in. Confirm: gender cards render and are clickable, garment-type pills load and populate from the real API, and choosing an image file for garment upload shows a progress overlay and then a preview (confirms the real presign+upload round trip against your local MinIO/R2).

- [ ] **Step 3: Commit**

```bash
git add apps/catalogues-web/src/app/embed/shopify-plugin-studio/embed-studio-wizard.tsx
git commit -m "feat(web): add gender/garment-type/upload steps to the embedded Studio wizard"
```

---

## Task 6: `EmbedStudioWizard` — face, background, pose, generate

Extends the same file with the remaining steps and wires up real generation plus the "Use this image" → postMessage handoff.

**Files:**
- Modify: `apps/catalogues-web/src/app/embed/shopify-plugin-studio/embed-studio-wizard.tsx`

**Interfaces:**
- Consumes: `SelCard`, `SectionHead`, `sectionCardStyle` (Task 1); `SelectGridModal` from `@/app/(app)/studio/select-modal` (existing, unmodified); `GenerationPanel`, `type GenerationJob` from `@/app/(app)/studio/generation-panel` (Task 2's additive props); `postImageSelectedToParent` from `@/lib/shopify-plugin-embed-protocol` (Task 3).
- Produces: nothing further consumes this file — it's a leaf page component.

- [ ] **Step 1: Add the new imports**

At the top of `embed-studio-wizard.tsx`, change:
```tsx
import { GenderCard, SectionHead, sectionCardStyle } from '@/app/(app)/studio/shared-cards';
```
to:
```tsx
import { GenderCard, SectionHead, SelCard, sectionCardStyle } from '@/app/(app)/studio/shared-cards';
import { GenerationPanel, type GenerationJob } from '@/app/(app)/studio/generation-panel';
import { SelectGridModal } from '@/app/(app)/studio/select-modal';
import { postImageSelectedToParent } from '@/lib/shopify-plugin-embed-protocol';
```

- [ ] **Step 2: Add the new item interfaces**

Directly below the `EmbedGarmentType` interface, add:
```tsx
interface FaceItem {
  id: string;
  label: string;
  thumbnailUrl: string;
  gender: string;
}
interface BackgroundItem {
  id: string;
  label: string;
  thumbnailUrl: string;
}
interface PoseItem {
  id: string;
  label: string;
  thumbnailUrl: string;
  hasLower: boolean;
  hasShoes: boolean;
}
```

- [ ] **Step 3: Add the new state, queries, and submit handler**

Inside the `EmbedStudioWizard` function, directly after the existing `uploadError` state declaration, add:
```tsx
  const [faceId, setFaceId] = useState('');
  const [backgroundId, setBackgroundId] = useState('');
  const [poseIds, setPoseIds] = useState<string[]>([]);
  const [faceModalOpen, setFaceModalOpen] = useState(false);
  const [backgroundModalOpen, setBackgroundModalOpen] = useState(false);
  const [poseModalOpen, setPoseModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [activeGeneration, setActiveGeneration] = useState<{
    catalogueId: string;
    jobs: GenerationJob[];
  } | null>(null);

  const { data: facesData } = useQuery<{ items: FaceItem[] }>({
    queryKey: ['embed-faces', gender],
    queryFn: () => api.get(`/v1/models/faces?gender=${gender}`),
  });
  const faces = facesData?.items ?? [];

  const { data: backgroundsData } = useQuery<{ items: BackgroundItem[] }>({
    queryKey: ['embed-backgrounds', gender],
    queryFn: () => api.get(`/v1/models/backgrounds?gender=${gender}`),
  });
  const backgrounds = backgroundsData?.items ?? [];

  const { data: posesData } = useQuery<{ items: PoseItem[] }>({
    queryKey: ['embed-poses', gender, garmentTypeId],
    queryFn: () =>
      api.get(
        `/v1/models/poses?gender=${gender}${garmentTypeId ? `&garmentTypeId=${garmentTypeId}` : ''}`,
      ),
    enabled: !!garmentTypeId,
  });
  const poses = posesData?.items ?? [];

  function togglePose(id: string) {
    setPoseIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  }

  const canGenerate =
    !!garmentKey && !!faceId && !!backgroundId && poseIds.length > 0 && !isUploading && !isSubmitting;

  async function handleGenerate() {
    if (!canGenerate || isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError('');
    try {
      const selectedGarmentType = garmentTypes.find((g) => g.id === garmentTypeId);
      const selectedPoses = poses.filter((p) => poseIds.includes(p.id));
      const needsLower = selectedPoses.some((p) => p.hasLower);
      const needsShoes = selectedPoses.some((p) => p.hasShoes);
      const { catalogueId, jobIds } = await api.post<{ catalogueId: string; jobIds: string[] }>(
        '/v1/jobs/tryon',
        {
          inputs: {
            upperGarmentKey: garmentKey,
            faceId,
            backgroundId,
            poseIds,
            garmentTypeId: garmentTypeId || undefined,
            lowerCatalogId: needsLower
              ? (selectedGarmentType?.defaultLowerCatalogId ?? undefined)
              : undefined,
            shoeCatalogId: needsShoes
              ? (selectedGarmentType?.defaultShoeCatalogId ?? undefined)
              : undefined,
          },
          aspectRatio: '1:1',
          resolution: 'HD',
          platform: 'Shopify',
        },
      );
      const submittedLooks = poseIds.map((poseId) => {
        const pose = poses.find((p) => p.id === poseId);
        return { poseId, label: pose?.label ?? 'Pose', thumbnailUrl: pose?.thumbnailUrl ?? '' };
      });
      setActiveGeneration({
        catalogueId,
        jobs: jobIds.map((id, i) => ({
          id,
          poseId: submittedLooks[i]?.poseId ?? '',
          label: submittedLooks[i]?.label ?? `Look ${i + 1}`,
          thumbnailUrl: submittedLooks[i]?.thumbnailUrl ?? '',
        })),
      });
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleStartOver() {
    setActiveGeneration(null);
    setPoseIds([]);
  }

  function handleUseImage(args: { url: string; jobId: string; poseLabel: string }) {
    postImageSelectedToParent({
      imageUrl: args.url,
      jobId: args.jobId,
      poseLabel: args.poseLabel,
    });
  }
```

- [ ] **Step 4: Add the face/background/pose sections and the generate/results area to the returned JSX**

Find the closing of the garment-upload `sectionCardStyle` card (the `</div>` that closes step 3, immediately before the wizard's outer closing `</div>`):
```tsx
        {uploadError && (
          <span style={{ fontSize: 12, color: C.pink, marginTop: 8 }}>{uploadError}</span>
        )}
      </div>
    </div>
  );
}
```
Replace with:
```tsx
        {uploadError && (
          <span style={{ fontSize: 12, color: C.pink, marginTop: 8 }}>{uploadError}</span>
        )}
      </div>

      {activeGeneration ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button
            type="button"
            onClick={handleStartOver}
            style={{
              alignSelf: 'flex-start',
              background: 'none',
              border: 'none',
              color: C.pink,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            ← Start a new photo
          </button>
          <GenerationPanel
            catalogueId={activeGeneration.catalogueId}
            jobs={activeGeneration.jobs}
            garmentPreviewUrl={garmentPreviewUrl}
            onUseImage={handleUseImage}
            hideCatalogueLink
          />
        </div>
      ) : (
        <>
          <div style={sectionCardStyle}>
            <SectionHead
              title="Model face"
              stepNumber={4}
              right={
                faces.length > 4 && (
                  <button
                    type="button"
                    onClick={() => setFaceModalOpen(true)}
                    style={{ background: 'none', border: 'none', color: C.pink, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                  >
                    View all
                  </button>
                )
              }
            />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {faces.slice(0, 4).map((f) => (
                <SelCard
                  key={f.id}
                  selected={faceId === f.id}
                  onClick={() => setFaceId(f.id)}
                  imageUrl={f.thumbnailUrl}
                  label={f.label}
                  w={100}
                  h={130}
                />
              ))}
            </div>
          </div>

          <div style={sectionCardStyle}>
            <SectionHead
              title="Background"
              stepNumber={5}
              right={
                backgrounds.length > 4 && (
                  <button
                    type="button"
                    onClick={() => setBackgroundModalOpen(true)}
                    style={{ background: 'none', border: 'none', color: C.pink, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                  >
                    View all
                  </button>
                )
              }
            />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {backgrounds.slice(0, 4).map((b) => (
                <SelCard
                  key={b.id}
                  selected={backgroundId === b.id}
                  onClick={() => setBackgroundId(b.id)}
                  imageUrl={b.thumbnailUrl}
                  label={b.label}
                  w={100}
                  h={130}
                />
              ))}
            </div>
          </div>

          <div style={sectionCardStyle}>
            <SectionHead
              title="Pose(s)"
              subtitle="Select one or more — each becomes its own generated photo"
              stepNumber={6}
              right={
                poses.length > 4 && (
                  <button
                    type="button"
                    onClick={() => setPoseModalOpen(true)}
                    style={{ background: 'none', border: 'none', color: C.pink, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                  >
                    View all
                  </button>
                )
              }
            />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {poses.slice(0, 4).map((p) => (
                <SelCard
                  key={p.id}
                  selected={poseIds.includes(p.id)}
                  onClick={() => togglePose(p.id)}
                  imageUrl={p.thumbnailUrl}
                  label={p.label}
                  w={100}
                  h={130}
                />
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
            <button
              type="button"
              disabled={!canGenerate}
              onClick={handleGenerate}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                height: 44,
                padding: '0 24px',
                borderRadius: 10,
                border: 'none',
                fontSize: 14,
                fontWeight: 700,
                color: '#fff',
                background: canGenerate
                  ? 'linear-gradient(91.84deg, #521D9C 0.33%, #BD2587 50.77%, #F96657 99.67%)'
                  : C.border2,
                cursor: canGenerate ? 'pointer' : 'not-allowed',
              }}
            >
              {isSubmitting ? <SpinnerIcon size={16} /> : null}
              Generate product photo{poseIds.length > 1 ? 's' : ''}
            </button>
            {submitError && <span style={{ fontSize: 12, color: C.pink }}>{submitError}</span>}
          </div>
        </>
      )}

      {faceModalOpen && (
        <SelectGridModal
          title="Choose a model face"
          items={faces}
          selectedIds={faceId ? [faceId] : []}
          onSelect={(id) => {
            setFaceId(id);
            setFaceModalOpen(false);
          }}
          onClose={() => setFaceModalOpen(false)}
        />
      )}
      {backgroundModalOpen && (
        <SelectGridModal
          title="Choose a background"
          items={backgrounds}
          selectedIds={backgroundId ? [backgroundId] : []}
          onSelect={(id) => {
            setBackgroundId(id);
            setBackgroundModalOpen(false);
          }}
          onClose={() => setBackgroundModalOpen(false)}
        />
      )}
      {poseModalOpen && (
        <SelectGridModal
          title="Choose pose(s)"
          items={poses}
          selectedIds={poseIds}
          multiSelect
          continueLabel="Use {count} pose(s)"
          onSelect={togglePose}
          onClose={() => setPoseModalOpen(false)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Verify end-to-end**

Run:
```bash
pnpm --filter @tryme/web typecheck
pnpm --filter @tryme/web lint
```
Expected: both PASS.

With the dev server running and Docker infra up (`pnpm docker:up`), visit `/embed/shopify-plugin-studio`, complete all six steps for a garment type that has faces/backgrounds/poses seeded locally, and click Generate. Confirm: `GenerationPanel` shows real progress (via SSE) and a real completed image. Click "Use this image" and confirm (via browser devtools' console, e.g. `window.addEventListener('message', console.log)` run in the *parent* frame before Task 8 exists, or simply confirm no console errors) that `postImageSelectedToParent` fires without throwing. Full end-to-end visual confirmation (image landing in the mock Media grid) happens in Task 8/9 once the parent page exists.

- [ ] **Step 6: Commit**

```bash
git add apps/catalogues-web/src/app/embed/shopify-plugin-studio/embed-studio-wizard.tsx
git commit -m "feat(web): add face/background/pose/generate steps to the embedded Studio wizard"
```

---

## Task 7: Static Shopify mock chrome + Add Product form (top half)

Builds the `/shopify-plugin` parent page: Shopify admin chrome, Title/Description/Media(seed only)/Category/Price, and the right-column Status/Publishing/Organization/Theme template panels — matching `image.png`. The Ai Vastra tile, modal, and iframe wiring come in Task 8. Media grid is stateful now so Task 8 can extend it.

**Files:**
- Create: `apps/catalogues-web/src/app/(app)/shopify-plugin/shopify-mock-data.ts`
- Create: `apps/catalogues-web/src/app/(app)/shopify-plugin/shopify-plugin-demo.tsx`
- Create: `apps/catalogues-web/src/app/(app)/shopify-plugin/page.tsx`

**Interfaces:**
- Produces (used/extended by Task 8): `MediaImage` type, `ShopifyPluginDemo` component (Task 8 adds the tile/modal/postMessage logic to this same file).

- [ ] **Step 1: Write the static seed data**

```ts
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export const MOCK_PRODUCT = {
  title: 'Banarasi Silk Saree - Royal Blue',
  seedMediaUrl: `${BASE}/assets/studio-right-div-placeholder.png`,
};

export const SHOPIFY_LEFT_NAV = [
  'Home',
  'Orders',
  'Products',
  'Customers',
  'Growth',
  'Discounts',
  'Content',
  'Markets',
  'Finance',
  'Analytics',
] as const;

export const SHOPIFY_SALES_CHANNELS = ['Online Store', 'Agentic'] as const;
```

- [ ] **Step 2: Write the parent demo component (chrome + top-half form, no Media interactivity yet)**

```tsx
'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { C } from '@/components/tokens';
import { api } from '@/lib/api';
import { MOCK_PRODUCT, SHOPIFY_LEFT_NAV, SHOPIFY_SALES_CHANNELS } from './shopify-mock-data';

export interface MediaImage {
  id: string;
  url: string;
  source: 'seed' | 'tryme';
}

function ShopifyChrome({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: '#f1f2f4',
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'inherit',
      }}
    >
      <div
        style={{
          height: 48,
          background: '#0e0e0e',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          color: '#fff',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>shopify</span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              background: 'rgba(255,255,255,0.12)',
              borderRadius: 6,
              padding: '2px 8px',
            }}
          >
            Spring '26
          </span>
        </div>
        <div style={{ fontSize: 12, color: '#c9cccf' }}>Ai Vastra Store Dev</div>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          style={{
            width: 200,
            background: '#0e0e0e',
            color: '#c9cccf',
            flexShrink: 0,
            padding: '16px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            fontSize: 13,
          }}
        >
          {SHOPIFY_LEFT_NAV.map((label) => (
            <div
              key={label}
              style={{
                padding: '8px 12px',
                borderRadius: 6,
                fontWeight: label === 'Products' ? 600 : 400,
                background: label === 'Products' ? 'rgba(255,255,255,0.1)' : 'transparent',
                color: label === 'Products' ? '#fff' : '#c9cccf',
              }}
            >
              {label}
            </div>
          ))}
          <div style={{ marginTop: 16, fontSize: 11, color: '#8a8d93', padding: '0 12px' }}>
            Sales channels
          </div>
          {SHOPIFY_SALES_CHANNELS.map((label) => (
            <div key={label} style={{ padding: '8px 12px', borderRadius: 6, fontSize: 13 }}>
              {label}
            </div>
          ))}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>{children}</div>
      </div>
    </div>
  );
}

function StaticCard({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #e3e3e3',
        borderRadius: 12,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {title && <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1a1a1a' }}>{title}</h3>}
      {children}
    </div>
  );
}

function StaticField({
  label,
  value,
  placeholder,
  multiline,
}: {
  label: string;
  value?: string;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 500, color: '#1a1a1a' }}>{label}</span>
      <div
        style={{
          border: '1px solid #c9cccf',
          borderRadius: 8,
          padding: '8px 12px',
          fontSize: 14,
          color: value ? '#1a1a1a' : '#8a8a8a',
          background: '#fff',
          minHeight: multiline ? 120 : undefined,
        }}
      >
        {value || placeholder}
      </div>
    </div>
  );
}

export function ShopifyPluginDemo() {
  const { data: me, isLoading: meLoading } = useQuery<{ isMerchant?: boolean }>({
    queryKey: ['me'],
    queryFn: () => api.get('/v1/me'),
    retry: false,
  });

  const [mediaImages, setMediaImages] = useState<MediaImage[]>([
    { id: 'seed', url: MOCK_PRODUCT.seedMediaUrl, source: 'seed' },
  ]);

  if (!meLoading && !me?.isMerchant) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: C.mid, fontSize: 14 }}>
        This preview is available for merchant accounts. Contact us to enable merchant features on
        your account.
      </div>
    );
  }

  return (
    <ShopifyChrome>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 20 }}>
        <span style={{ fontSize: 12, color: '#6b6f76' }}>Products &gt; Add product</span>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, color: '#1a1a1a' }}>Add product</h1>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <StaticCard>
            <StaticField label="Title" value={MOCK_PRODUCT.title} />
            <StaticField label="Description" multiline placeholder="Short sleeve t-shirt" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: '#1a1a1a' }}>Media</span>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {mediaImages.map((img) => (
                  <div
                    key={img.id}
                    style={{
                      position: 'relative',
                      width: 100,
                      height: 100,
                      borderRadius: 8,
                      overflow: 'hidden',
                      border: '1px solid #c9cccf',
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  </div>
                ))}
                <div
                  style={{
                    width: 100,
                    height: 100,
                    borderRadius: 8,
                    border: '1px dashed #c9cccf',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#8a8a8a',
                    fontSize: 24,
                  }}
                >
                  +
                </div>
              </div>
            </div>
            <StaticField label="Category" placeholder="Choose a product category" />
          </StaticCard>
          <StaticCard title="Price">
            <div style={{ display: 'flex', gap: 12 }}>
              <StaticField label="Price" value="$ 0.00" />
              <StaticField label="Compare-at price" placeholder="$ 0.00" />
            </div>
          </StaticCard>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <StaticCard title="Status">
            <StaticField label="" value="Active" />
          </StaticCard>
          <StaticCard title="Publishing">
            <StaticField label="" value="All channels" />
          </StaticCard>
          <StaticCard title="Product organization">
            <StaticField label="Type" placeholder="None" />
            <StaticField label="Vendor" placeholder="None" />
            <StaticField label="Collections" placeholder="+ Add collections" />
            <StaticField label="Tags" placeholder="+ Add tags" />
          </StaticCard>
          <StaticCard title="Theme template">
            <StaticField label="" value="Default product" />
          </StaticCard>
        </div>
      </div>
    </ShopifyChrome>
  );
}
```

- [ ] **Step 3: Write the page wrapper**

```tsx
import { ShopifyPluginDemo } from './shopify-plugin-demo';

export const metadata = {
  title: 'Shopify Plugin Preview | Ai Vastra',
};

export default function ShopifyPluginPage() {
  return <ShopifyPluginDemo />;
}
```

- [ ] **Step 4: Verify**

Run:
```bash
pnpm --filter @tryme/web typecheck
pnpm --filter @tryme/web lint
```
Expected: both PASS.

Visit `/shopify-plugin` directly in the browser (it's not linked from the sidebar yet — that's Task 9). Confirm: dark Shopify chrome renders, "Add product" heading shows, the seed image appears in the Media grid next to a plain "+" tile, and the Title/Category/Price/Status/Publishing/Organization/Theme fields show the static placeholder content matching `image.png`. Log in as a non-merchant test account (or temporarily mock `isMerchant: false` in devtools) and confirm the gated message shows instead.

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/shopify-plugin/
git commit -m "feat(web): add static Shopify Add Product mock (top half) at /shopify-plugin"
```

---

## Task 8: Inventory/Shipping/Variants/Purchase options + Ai Vastra tile + iframe modal

Extends `shopify-plugin-demo.tsx` with the lower half of the mock page (`image2.png`) and the live plugin entry point: the branded Media tile, the modal, the iframe, and the `postMessage` listener that appends generated images to the grid.

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/shopify-plugin/shopify-plugin-demo.tsx`

**Interfaces:**
- Consumes: `isEmbedImageSelectedMessage` from `@/lib/shopify-plugin-embed-protocol` (Task 3); `SparkleIcon`, `XIcon` from `@/components/icons`.
- Produces: nothing further consumes this file.

- [ ] **Step 1: Add the new imports**

Change:
```tsx
'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { C } from '@/components/tokens';
import { api } from '@/lib/api';
import { MOCK_PRODUCT, SHOPIFY_LEFT_NAV, SHOPIFY_SALES_CHANNELS } from './shopify-mock-data';
```
to:
```tsx
'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { SparkleIcon, XIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { api } from '@/lib/api';
import { isEmbedImageSelectedMessage } from '@/lib/shopify-plugin-embed-protocol';
import { MOCK_PRODUCT, SHOPIFY_LEFT_NAV, SHOPIFY_SALES_CHANNELS } from './shopify-mock-data';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
```

- [ ] **Step 2: Add the Ai Vastra tile, modal state, and postMessage listener inside `ShopifyPluginDemo`**

Find:
```tsx
  const [mediaImages, setMediaImages] = useState<MediaImage[]>([
    { id: 'seed', url: MOCK_PRODUCT.seedMediaUrl, source: 'seed' },
  ]);

  if (!meLoading && !me?.isMerchant) {
```
Replace with:
```tsx
  const [mediaImages, setMediaImages] = useState<MediaImage[]>([
    { id: 'seed', url: MOCK_PRODUCT.seedMediaUrl, source: 'seed' },
  ]);
  const [studioModalOpen, setStudioModalOpen] = useState(false);

  useEffect(() => {
    if (!studioModalOpen) return;
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (!isEmbedImageSelectedMessage(event.data)) return;
      setMediaImages((prev) => [
        ...prev,
        { id: event.data.jobId, url: event.data.imageUrl, source: 'tryme' as const },
      ]);
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [studioModalOpen]);

  if (!meLoading && !me?.isMerchant) {
```

- [ ] **Step 3: Add the Ai Vastra tile to the Media grid and badge generated images**

Find:
```tsx
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {mediaImages.map((img) => (
                  <div
                    key={img.id}
                    style={{
                      position: 'relative',
                      width: 100,
                      height: 100,
                      borderRadius: 8,
                      overflow: 'hidden',
                      border: '1px solid #c9cccf',
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  </div>
                ))}
                <div
                  style={{
                    width: 100,
                    height: 100,
                    borderRadius: 8,
                    border: '1px dashed #c9cccf',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#8a8a8a',
                    fontSize: 24,
                  }}
                >
                  +
                </div>
              </div>
```
Replace with:
```tsx
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {mediaImages.map((img) => (
                  <div
                    key={img.id}
                    style={{
                      position: 'relative',
                      width: 100,
                      height: 100,
                      borderRadius: 8,
                      overflow: 'hidden',
                      border: '1px solid #c9cccf',
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    {img.source === 'tryme' && (
                      <span
                        style={{
                          position: 'absolute',
                          bottom: 4,
                          left: 4,
                          right: 4,
                          fontSize: 9,
                          fontWeight: 700,
                          color: '#fff',
                          background:
                            'linear-gradient(91.84deg, #521D9C 0.33%, #BD2587 50.77%, #F96657 99.67%)',
                          borderRadius: 6,
                          padding: '2px 4px',
                          textAlign: 'center',
                        }}
                      >
                        ✨ Ai Vastra
                      </span>
                    )}
                  </div>
                ))}
                <div
                  style={{
                    width: 100,
                    height: 100,
                    borderRadius: 8,
                    border: '1px dashed #c9cccf',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#8a8a8a',
                    fontSize: 24,
                  }}
                >
                  +
                </div>
                <button
                  type="button"
                  onClick={() => setStudioModalOpen(true)}
                  style={{
                    width: 100,
                    height: 100,
                    borderRadius: 8,
                    cursor: 'pointer',
                    background:
                      'linear-gradient(#fff,#fff) padding-box, linear-gradient(135deg, #521D9C 0%, #BD2587 50%, #F96657 100%) border-box',
                    border: '2px dashed transparent',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  <span style={{ color: '#BD2587' }}>
                    <SparkleIcon />
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: '#BD2587',
                      textAlign: 'center',
                      lineHeight: 1.2,
                      padding: '0 6px',
                    }}
                  >
                    Generate with Ai Vastra
                  </span>
                </button>
              </div>
```

- [ ] **Step 4: Add Inventory/Shipping/Variants/Purchase options below the existing two-column grid**

Find the end of the two-column grid `<div>` in the returned JSX:
```tsx
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <StaticCard title="Status">
            <StaticField label="" value="Active" />
          </StaticCard>
          <StaticCard title="Publishing">
            <StaticField label="" value="All channels" />
          </StaticCard>
          <StaticCard title="Product organization">
            <StaticField label="Type" placeholder="None" />
            <StaticField label="Vendor" placeholder="None" />
            <StaticField label="Collections" placeholder="+ Add collections" />
            <StaticField label="Tags" placeholder="+ Add tags" />
          </StaticCard>
          <StaticCard title="Theme template">
            <StaticField label="" value="Default product" />
          </StaticCard>
        </div>
      </div>
    </ShopifyChrome>
  );
}
```
Replace with:
```tsx
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <StaticCard title="Status">
            <StaticField label="" value="Active" />
          </StaticCard>
          <StaticCard title="Publishing">
            <StaticField label="" value="All channels" />
          </StaticCard>
          <StaticCard title="Product organization">
            <StaticField label="Type" placeholder="None" />
            <StaticField label="Vendor" placeholder="None" />
            <StaticField label="Collections" placeholder="+ Add collections" />
            <StaticField label="Tags" placeholder="+ Add tags" />
          </StaticCard>
          <StaticCard title="Theme template">
            <StaticField label="" value="Default product" />
          </StaticCard>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, marginTop: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <StaticCard title="Inventory">
            <div
              style={{
                border: '1px solid #e3e3e3',
                borderRadius: 8,
                overflow: 'hidden',
                fontSize: 13,
              }}
            >
              {['My Custom Location', 'Shop location'].map((loc, i) => (
                <div
                  key={loc}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 14px',
                    borderTop: i === 0 ? 'none' : '1px solid #e3e3e3',
                    background: i === 0 ? '#fafafa' : '#fff',
                  }}
                >
                  <span style={{ color: '#1a1a1a' }}>{loc}</span>
                  <span
                    style={{
                      border: '1px solid #c9cccf',
                      borderRadius: 6,
                      padding: '4px 10px',
                      color: '#1a1a1a',
                    }}
                  >
                    0
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <StaticField label="SKU" placeholder="" />
              <StaticField label="Barcode" placeholder="" />
            </div>
          </StaticCard>
          <StaticCard title="Shipping">
            <StaticField
              label="Package"
              value="Store default · Sample box - 8.6 x 5.4 x 1.6 in, 0 lb"
            />
            <StaticField label="Product weight" value="0.0 lb" />
          </StaticCard>
          <StaticCard title="Variants">
            <StaticField label="" placeholder="+ Add options like size or color" />
          </StaticCard>
          <StaticCard title="Purchase options">
            <StaticField
              label=""
              placeholder="+ Subscriptions, preorders, try before you buy, and more"
            />
          </StaticCard>
        </div>
        <div />
      </div>

      {studioModalOpen && (
        // biome-ignore lint/a11y/noStaticElementInteractions: click-outside-to-dismiss backdrop; Close button below is the keyboard path
        <div
          role="presentation"
          onClick={() => setStudioModalOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation only */}
          <div
            role="presentation"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 820,
              maxWidth: '92vw',
              height: 720,
              maxHeight: '90vh',
              background: '#fff',
              borderRadius: 12,
              boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 20px',
                borderBottom: `1px solid ${C.border}`,
              }}
            >
              <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
                Generate product photos with Ai Vastra
              </span>
              <button
                type="button"
                onClick={() => setStudioModalOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: C.mid,
                  display: 'flex',
                }}
              >
                <XIcon size={20} />
              </button>
            </div>
            <iframe
              src={`${BASE}/embed/shopify-plugin-studio`}
              title="Ai Vastra product photo generator"
              style={{ flex: 1, border: 'none', width: '100%' }}
            />
            <div
              style={{
                padding: '12px 20px',
                borderTop: `1px solid ${C.border}`,
                display: 'flex',
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                onClick={() => setStudioModalOpen(false)}
                style={{
                  height: 36,
                  padding: '0 18px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'linear-gradient(135deg, #7c3aed 0%, #BD2587 100%)',
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </ShopifyChrome>
  );
}
```

- [ ] **Step 5: Verify the full end-to-end flow**

Run:
```bash
pnpm --filter @tryme/web typecheck
pnpm --filter @tryme/web lint
```
Expected: both PASS.

With `pnpm docker:up` and `pnpm --filter @tryme/web dev` running, visit `/shopify-plugin`. Confirm:
1. Inventory/SKU/Barcode/Shipping/Variants/Purchase options render below the fold, matching `image2.png`.
2. The "Generate with Ai Vastra" tile sits in the Media grid next to the "+" tile.
3. Clicking it opens the modal with the iframe loading `/embed/shopify-plugin-studio` inside.
4. Complete the wizard (gender → garment type → upload → face → background → pose → generate), wait for a real completed result, click "Use this image".
5. Confirm the image appears **live** in the parent page's Media grid (modal stays open) with the "✨ Ai Vastra" badge, without a full page reload.
6. Click "Done" — modal closes, the new image persists in the grid (until page reload, since this is intentionally non-persisted local state).

- [ ] **Step 6: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/shopify-plugin/shopify-plugin-demo.tsx
git commit -m "feat(web): wire the Ai Vastra Media tile, iframe modal, and postMessage handoff"
```

---

## Task 9: Sidebar nav entry + final integration pass

**Files:**
- Modify: `apps/catalogues-web/src/components/sidebar.tsx`

- [ ] **Step 1: Add the `Store` icon import**

Find:
```tsx
import { KeyRound, MonitorPlay, Package, Phone } from 'lucide-react';
```
Replace with:
```tsx
import { KeyRound, MonitorPlay, Package, Phone, Store } from 'lucide-react';
```

- [ ] **Step 2: Add the NAV entry**

Find:
```tsx
  {
    id: 'developers',
    href: '/developers',
    label: 'Developers',
    icon: 'key',
    merchantOnly: true,
  },
  { id: 'pricing', href: '/pricing', label: 'Pricing', icon: `${BASE}/assets/pricing-icon.svg` },
```
Replace with:
```tsx
  {
    id: 'developers',
    href: '/developers',
    label: 'Developers',
    icon: 'key',
    merchantOnly: true,
  },
  {
    id: 'shopify-plugin',
    href: '/shopify-plugin',
    label: 'Shopify Plugin',
    icon: 'store',
    merchantOnly: true,
  },
  { id: 'pricing', href: '/pricing', label: 'Pricing', icon: `${BASE}/assets/pricing-icon.svg` },
```

- [ ] **Step 3: Add it to the BUSINESS group**

Find:
```tsx
    {
      title: 'BUSINESS',
      items: visibleNav.filter((item) => ['pricing', 'developers'].includes(item.id)),
    },
```
Replace with:
```tsx
    {
      title: 'BUSINESS',
      items: visibleNav.filter((item) =>
        ['pricing', 'developers', 'shopify-plugin'].includes(item.id),
      ),
    },
```

- [ ] **Step 4: Add the icon rendering case**

Find:
```tsx
                        {item.icon === 'monitor-play' ? (
                          <MonitorPlay
                            size={16}
                            style={{ color: isActive ? '#FFFFFF' : '#BABABB' }}
                          />
                        ) : item.icon === 'phone' ? (
                          <Phone size={16} style={{ color: isActive ? '#FFFFFF' : '#BABABB' }} />
                        ) : item.icon === 'package' ? (
                          <Package size={16} style={{ color: isActive ? '#FFFFFF' : '#BABABB' }} />
                        ) : item.icon === 'key' ? (
                          <KeyRound size={16} style={{ color: isActive ? '#FFFFFF' : '#BABABB' }} />
                        ) : (
```
Replace with:
```tsx
                        {item.icon === 'monitor-play' ? (
                          <MonitorPlay
                            size={16}
                            style={{ color: isActive ? '#FFFFFF' : '#BABABB' }}
                          />
                        ) : item.icon === 'phone' ? (
                          <Phone size={16} style={{ color: isActive ? '#FFFFFF' : '#BABABB' }} />
                        ) : item.icon === 'package' ? (
                          <Package size={16} style={{ color: isActive ? '#FFFFFF' : '#BABABB' }} />
                        ) : item.icon === 'key' ? (
                          <KeyRound size={16} style={{ color: isActive ? '#FFFFFF' : '#BABABB' }} />
                        ) : item.icon === 'store' ? (
                          <Store size={16} style={{ color: isActive ? '#FFFFFF' : '#BABABB' }} />
                        ) : (
```

- [ ] **Step 5: Full manual walkthrough**

Run:
```bash
pnpm --filter @tryme/web typecheck
pnpm --filter @tryme/web lint
pnpm --filter @tryme/web build
```
Expected: all three PASS (the production build catches issues typecheck/dev mode sometimes miss).

With `pnpm docker:up` and `pnpm --filter @tryme/web dev` running, log in as a merchant account and walk the entire flow from scratch:
1. Sidebar shows a new **"Shopify Plugin"** entry in the BUSINESS group (with a storefront icon), between Developers and Pricing.
2. Click it → lands on `/shopify-plugin`, full mock Shopify page renders.
3. Click the "Generate with Ai Vastra" media tile → modal opens with the iframe.
4. Complete all six wizard steps with a real garment photo, generate, wait for a real result.
5. Click "Use this image" → image lands in the parent's Media grid live, badged.
6. Click "Done" → modal closes, image persists in the grid.
7. Log out, log back in as a non-merchant account (or a fresh account with no merchant record) → sidebar does **not** show "Shopify Plugin", and navigating to `/shopify-plugin` directly shows the "available for merchant accounts" message instead of a crash.
8. Revisit `/studio` (the real page) and run one generation there — confirm it behaves identically to before this plan (no "Use this image" button, "View full catalogue →" still present) — proves Tasks 1–2's refactors didn't regress the production page.

- [ ] **Step 6: Commit**

```bash
git add apps/catalogues-web/src/components/sidebar.tsx
git commit -m "feat(web): add Shopify Plugin sidebar entry"
```

---

## Self-Review

**Spec coverage:**
- Sidebar entry, BUSINESS group, merchant-only → Task 9. ✓
- Real same-origin iframe, `/embed` route group with no chrome → Task 4. ✓
- Fully-functional generation reusing real endpoints → Tasks 5–6. ✓
- Media-grid entry point, extra tile next to "+" → Task 8. ✓
- Explicit "Use this image" confirm, multi-pose batch, per-result confirm, modal stays open → Task 2 (panel support) + Task 8 (listener keeps modal open, appends live). ✓
- Full static replica of both reference screenshots, non-interactive except Media grid → Tasks 7–8. ✓
- Scope boundaries (no platform/aspect picker, no lower/shoe picker, no mannequin/dual-upload types) → Task 5 (garment-type filter) + Task 6 (fixed `aspectRatio`/`resolution`, default-catalog fallback). ✓
- Reuse-not-refactor of Studio internals → Task 1 (safe extraction) + Task 2 (additive-only panel props). ✓

**Placeholder scan:** no "TBD"/"TODO" strings; every code block is complete, runnable code with concrete values (e.g. `aspectRatio: '1:1'`, real Shopify screenshot content baked into `shopify-mock-data.ts`).

**Type consistency:** `EmbedImageSelectedMessage` (Task 3) is the single shape used by both `postImageSelectedToParent` (Task 6, inside the iframe) and `isEmbedImageSelectedMessage` (Task 8, in the parent) — same field names (`imageUrl`, `jobId`, `poseLabel`) on both sides. `GenerationPanelProps.onUseImage` (Task 2) takes `{ url, jobId, poseLabel }`; Task 6's `handleUseImage` receives that shape and must explicitly map `url` → `imageUrl` when calling `postImageSelectedToParent` (its parameter is `{ imageUrl, jobId, poseLabel }`) — Task 6 Step 3's code now does this mapping explicitly rather than forwarding `args` as-is.
