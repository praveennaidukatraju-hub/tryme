# Pricing Page — Viewport-Tier Responsive Rebuild — Design

## Goal

`apps/catalogues-web/src/app/(app)/pricing/page.tsx` is written entirely as inline `style={{...}}` objects with hardcoded pixel widths (320px cards, 300px credit panel, 410px offline cards) and zero media queries. It breaks below ~1024px: the Current Plan Banner doesn't stack, the country-selector popover can overflow a narrow viewport, and the card grid only survives via `flexWrap` at a fixed card width. This is a test case for a new pattern: instead of patching individual elements with inline responsive tweaks, detect the viewport tier in JS and render a dedicated layout component per tier. If this works well on the pricing page, the same `useBreakpoint()` hook becomes the template for other pages.

## Tiers

Five tiers, standard ranges:

| Tier | Range |
|------|-------|
| `mobile` | < 640px |
| `tablet` | 640–1023px |
| `small-laptop` | 1024–1279px |
| `laptop` | 1280–1535px |
| `desktop` | ≥ 1536px |

## Architecture

Three concerns, kept separate so nothing gets duplicated across tiers:

1. **Shared data/business-logic layer** — a `usePricingData()` hook holding everything in today's `PricingPage` that isn't rendering: the 5 `useQuery` calls (`credits`, `me`, `payment-history`, `credit-plans`, `resolution-configs`), `buy()` (the Razorpay checkout flow), `formatPrice()`/`displayBase()`/`displayTotal()`/`displayTax()`, and country/rate state. This runs exactly once regardless of tier. A bug fix to the checkout flow or price math happens in one file, not up to five.
2. **A reusable breakpoint hook** — `useBreakpoint()`, not pricing-specific. Returns `'mobile' | 'tablet' | 'small-laptop' | 'laptop' | 'desktop' | null`. This is the piece meant to seed the pattern for future pages.
3. **Tier layout components** — pure presentational components that take `PricingLayoutProps` (the return type of `usePricingData()`) and render JSX. Only built where the layout genuinely needs to differ; tiers that don't need a different layout render the same component rather than a duplicated copy.

`page.tsx` becomes a thin dispatcher:

```tsx
export default function PricingPage() {
  const data = usePricingData();
  const tier = useBreakpoint();
  if (tier === null) return <PricingSkeleton />;
  if (tier === 'mobile') return <Mobile {...data} />;
  if (tier === 'tablet') return <Tablet {...data} />;
  return <Desktop {...data} />; // small-laptop | laptop | desktop
}
```

`small-laptop` and `laptop` alias to `Desktop.tsx` — the existing 3-column grid (3 × 320px + gaps + padding ≈ 1048px) already fits comfortably above 1024px, so building two more visually-identical layout files would be pure duplication with no behavioral difference.

## File plan

```
apps/catalogues-web/src/
  hooks/
    use-breakpoint.ts              — new, reusable across future pages
  app/(app)/pricing/
    page.tsx                       — rewritten: thin dispatcher
    use-pricing-data.ts            — new: extracted data-fetching + business logic
    loading.tsx                    — unchanged (Next.js route-level Suspense fallback)
    layouts/
      types.ts                     — new: `PricingLayoutProps = ReturnType<typeof usePricingData>`
      desktop.tsx                  — today's JSX moved here verbatim, minus the extracted logic (now reads from props)
      tablet.tsx                   — new
      mobile.tsx                   — new
```

`layouts/desktop.tsx` is a near-verbatim move of the current `PricingPage` body: same JSX, same fixed-width card grid, same banner layout — nothing about it changes behaviorally. The only edit is that it now receives its data via `PricingLayoutProps` instead of calling the hooks itself.

## `useBreakpoint()` — detection mechanism

```ts
export type Tier = 'mobile' | 'tablet' | 'small-laptop' | 'laptop' | 'desktop';

const QUERIES: Record<Tier, string> = {
  mobile: '(max-width: 639px)',
  tablet: '(min-width: 640px) and (max-width: 1023px)',
  'small-laptop': '(min-width: 1024px) and (max-width: 1279px)',
  laptop: '(min-width: 1280px) and (max-width: 1535px)',
  desktop: '(min-width: 1536px)',
};

export function useBreakpoint(): Tier | null {
  const [tier, setTier] = useState<Tier | null>(null);

  useLayoutEffect(() => {
    const mqls = (Object.entries(QUERIES) as [Tier, string][]).map(
      ([t, q]) => [t, window.matchMedia(q)] as const,
    );
    const resolve = () => {
      const match = mqls.find(([, mql]) => mql.matches);
      setTier(match ? match[0] : 'desktop');
    };
    resolve();
    mqls.forEach(([, mql]) => mql.addEventListener('change', resolve));
    return () => mqls.forEach(([, mql]) => mql.removeEventListener('change', resolve));
  }, []);

  return tier;
}
```

**Hydration safety:** `useBreakpoint()` returns `null` on the server and on the client's first render, so SSR HTML and the client's initial hydration pass match exactly — no hydration-mismatch warning. `useLayoutEffect` then resolves the real tier synchronously before the browser paints, so in practice the `null` state is never visibly rendered — it exists only to satisfy hydration, not as a user-facing loading state.

`page.tsx`'s `tier === null` branch reuses the existing skeleton markup from `pricing/loading.tsx` (same `<Skeleton>` component, same layout) rather than introducing a new placeholder — that markup already exists and is visually correct for this page.

**Live resize:** `matchMedia` listeners stay attached for the component's lifetime, so resizing the browser (devtools device toolbar, an actual tablet rotating) re-resolves the tier and re-renders the matching layout — this isn't a mount-once measurement.

## Screen-by-screen differences (Mobile / Tablet vs. Desktop)

`Desktop.tsx` is unchanged today's behavior. What's actually new:

- **Current Plan Banner** (`page.tsx:481-633` today) — Desktop is a fixed side-by-side flex row: plan info on the left, a 300px credits panel on the right, separated by a vertical divider, `minHeight: 160`. Mobile and Tablet both stack these vertically instead (plan info block, then credits block below it, no fixed side panel, no vertical divider).
- **Pricing card grid** (`page.tsx:1280-1647`) — Desktop keeps the existing fixed `width: 320` cards relying on `flexWrap`. Mobile renders a single column of full-width cards. Tablet renders a 2-column CSS grid using `minmax()` track sizing (not a fixed 320px), so it flexes across the full 640–1023px range instead of only surviving at the wide end of that range via wrapping.
- **Country selector** (`page.tsx:375-450`) — Desktop keeps the floating 200px popover anchored under the topbar button. Mobile renders it as a full-width dropdown instead — the floating popover's fixed width can overflow a 375px viewport. Tablet keeps the same floating popover as Desktop — a 200px popover has no overflow risk anywhere in the 640–1023px range, so no tablet-specific treatment is needed here.
- **Tab toggle and footer info bar** — no structural change on any tier; the existing flex layout and text wrapping already handle narrow widths correctly.

Sale modal, toast, and the (currently disabled, `false &&`-gated) offline try-on cards section are shared markup pulled unchanged into whichever layout renders them — they're not part of what's visually broken today.

## Reusability for future pages

`use-breakpoint.ts` lives in the shared `src/hooks/` directory specifically so other pages can adopt the same pattern later: `usePageData()` hook for data/logic + `layouts/{mobile,tablet,desktop}.tsx` for presentation + a thin dispatcher in `page.tsx`. Tiers that don't need a distinct layout keep aliasing to the nearest one that fits, rather than every page being forced into 5 real files.

## Testing plan

No backend changes. Frontend: `pnpm typecheck` and `pnpm lint` must stay clean. No browser automation available in this environment (consistent with prior responsive-work rounds in this codebase), so verification is manual resize/screenshot checks at representative widths: 375px (mobile), 800px (tablet), 1100px (confirms small-laptop aliases correctly to `Desktop.tsx` with no visual regression), 1728px (desktop, confirms today's behavior is byte-for-byte unchanged).

## Open trade-offs

- `small-laptop` and `laptop` currently alias to `Desktop.tsx`. If a future page genuinely needs different treatment at those tiers, that page gets its own dedicated layout file for them — this spec doesn't force every page to skip those tiers, just this one, because the math for this specific card grid says they don't need it.
- The `tier === null` skeleton window is theoretically visible on a very slow device (JS parse/hydrate taking long enough for a real paint to happen before `useLayoutEffect` fires), but this is the same constraint every client-viewport-dependent React pattern has, and is not worth a server-side user-agent-sniffing fallback for a first rollout.
