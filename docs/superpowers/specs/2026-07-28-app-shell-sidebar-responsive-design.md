# App Shell — Responsive Sidebar (Off-Canvas Drawer) — Design

## Goal

Every page under `apps/catalogues-web/src/app/(app)/` is wrapped by `AppShell` (`apps/catalogues-web/src/components/app-shell.tsx`), which renders a permanent, fixed 200px-wide `Sidebar` with zero viewport-based logic. On a mobile viewport (~375px), this leaves only ~175px for actual page content — the direct reason the pricing page's new `Mobile`/`Tablet` layouts (built earlier this session) still looked broken when tested, even though their own internal viewport-tier dispatch is working correctly. This fixes the foundation instead of compensating for it page-by-page: below 1024px, the sidebar becomes a hamburger-triggered off-canvas drawer (the same pattern used by Notion, GitHub, Linear, Vercel, Slack) instead of a permanent rail. Once this ships, every page automatically gets its full viewport width back — no per-page changes required.

## Explicit scope boundary

This spec covers **only** the sidebar/shell responsive mechanism. Two adjacent, reasonable ideas raised during brainstorming are explicitly deferred to their own future specs, not bundled in here:
- Redesigning `TopBar`'s own right-side content (Support button, phone link, `UserMenu`) into a mobile overflow menu.
- Renaming/expanding `useBreakpoint()` into a richer `useViewport()` returning `{ tier, width, isMobile, isTablet, isDesktop }`.

**Explicit regression requirement:** Desktop and small-laptop behavior (viewport ≥ 1024px) must remain byte-for-byte identical to today's implementation — same permanent rail, same layout, same everything. This is the acceptance bar for review: nothing here should be visible or observable at ≥1024px.

## Architecture

```
AppShell
├── SidebarProvider                    — owns drawer state, one instance for the whole app
│     └── SidebarContext
│           ├── isDrawerMode           — true when navigation should use the drawer
│           ├── isOpen                 — is the drawer currently open
│           ├── open()
│           ├── close()
│           └── toggle()
├── TopBar
│      └── ☰  (rendered only when isDrawerMode)
├── Sidebar
│      ├── permanent rail              — when !isDrawerMode (today's exact behavior, untouched)
│      └── drawer + backdrop           — when isDrawerMode
└── {children} (the page)
```

- **AppShell** decides *when* drawer mode applies.
- **SidebarContext** owns the open/closed state and the actions to change it.
- **TopBar** only triggers the drawer — it doesn't know how the state is stored.
- **Sidebar** only renders itself — it doesn't know why it's in drawer mode vs. rail mode.
- **Pages** are completely unaware this exists — zero changes needed to any individual page.

### Two independent concerns, kept separate

`isMobileLayout` (a fact about the viewport) and `useDrawerNavigation` (a decision about navigation UX) are deliberately different values, not one overloaded boolean. `isMobileLayout` is also deliberately **not** derived from `useBreakpoint()`'s tier output — that hook's five thresholds exist to serve pricing's card-grid breakpoints, and if those ever get retuned for pricing-specific reasons, the global nav's drawer cutoff must not silently shift with them. Instead, extract the generic matchMedia-plus-listener mechanism that already lives inside `useBreakpoint()` into a small reusable primitive:

```ts
// src/hooks/use-media-query.ts
export function useMediaQuery(query: string): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null);

  useLayoutEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const handler = () => setMatches(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}
```

`window.matchMedia(query)` is created exactly once per distinct `query` string — inside the effect, gated by the `[query]` dependency array, not in the render body. Every call site here passes a literal, unchanging query string, so in practice this runs once per mount and never recreates the `MediaQueryList` or re-attaches a listener on every render.

`useBreakpoint()` is refactored to be five calls to this primitive internally — same public API (`Tier | null`, same five tier names and thresholds), zero external behavior change, pure internal refactor. `AppShell` makes its own independent call with its own threshold:

```ts
const isMobileLayout = useMediaQuery('(max-width: 1023px)');
const useDrawerNavigation = isSellio || !!isMobileLayout;
```

This shares the one tested reactive mechanism (no duplicated matchMedia/listener-lifecycle logic, no non-reactive direct `window.innerWidth` read) while giving `AppShell` a threshold that can never drift when pricing's tiers change later. This also keeps the door open for future triggers (kiosk mode, an embedded/iframe mode, an admin-forced setting) to extend `useDrawerNavigation` without redefining what `isMobileLayout` means. Today, `useDrawerNavigation` unifies the *existing* `/sellio` special case (which already hides the sidebar behind its own floating toggle) with the new viewport-based case under one rendering mechanism — instead of maintaining two separate overlay implementations, `/sellio`'s existing floating pill-button toggle stays completely untouched and separate; only the underlying drawer/backdrop *rendering* is shared.

## Behavior

**Initial/transition state:** in rail mode (`!useDrawerNavigation`), `isOpen` is irrelevant — `Sidebar` renders unconditionally as it does today, regardless of `isOpen`'s value. What matters is the moment of *entering* drawer mode: `SidebarProvider` runs `useEffect(() => { if (useDrawerNavigation) close(); }, [useDrawerNavigation])`, resetting to closed every time drawer mode turns on — whether that's an initial mount already below 1024px (loading the app directly on a phone), narrowing an existing desktop session below 1024px, or navigating to `/sellio`. Without this, resizing down from desktop (rail visible) to mobile (drawer mode) could otherwise leave the drawer open by inherited state instead of collapsed by default.

**Closing — two mechanisms, not one:**
1. **Primary, robust:** `AppShell` runs `useEffect(() => close(), [pathname])` using the existing `usePathname()` call it already has (today used for the `isSellio` check). This closes the drawer on *any* navigation — clicked link, browser back/forward, `router.push()`, a redirect, a login redirect, a deep link — not just the one path a developer remembered to wire up.
2. **Optimization on top:** `Sidebar` gains an optional `onNavigate` callback, invoked synchronously from each nav `<Link>`'s `onClick`. This closes the drawer at the instant of tapping rather than waiting for the route transition to fully commit and `usePathname()` to update — avoids a brief visible lag where the new page renders behind a still-open drawer.

**ESC key:** while `isOpen && useDrawerNavigation`, a `keydown` listener (attached in `SidebarProvider`) closes on `Escape`. Gating on both — not just `isOpen` — matters for the resize-cleanup requirement below.

**Body scroll lock:**

```ts
useEffect(() => {
  if (!(isOpen && useDrawerNavigation)) return;
  const previous = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return () => {
    document.body.style.overflow = previous;
  };
}, [isOpen, useDrawerNavigation]);
```

The captured `previous` value lives only inside this effect's closure — not in `SidebarProvider`'s state or context — so it composes correctly with React's own cleanup lifecycle (runs exactly once per lock, restores exactly what it overwrote) without adding a mutable field to the provider that nothing else needs to read.

**Backdrop vs. drawer clicks:** the backdrop (`position: fixed; inset: 0`) and the drawer panel are separate sibling elements (not nested) at the DOM level. Clicking the backdrop calls `close()`; clicking inside the drawer panel does nothing special and — because they're siblings, not parent/child — never bubbles into the backdrop's click handler. No `stopPropagation()` needed; this falls out of the DOM structure itself.

**Focus restore (accessibility):** the hamburger `<button>` (rendered inside `TopBar`) holds its own ref and runs `useEffect` watching `isOpen` from context — when it transitions from `true` to `false`, call `buttonRef.current?.focus()`, unconditionally (not gated on how the drawer was opened). This matches the standard WAI-ARIA dialog/menu pattern — focus returns to the trigger element regardless of input modality, so a user who closes via ESC or backdrop-click never loses their place to `<body>`. The "unexpected jump for mouse users" concern doesn't apply here: `:focus-visible` already suppresses the visible ring for mouse-triggered focus, so a mouse user's restored focus is invisible to them and never reads as a jump. This keeps focus-management logic co-located with the actual DOM node that needs it, rather than `AppShell` needing to know anything about `TopBar`'s internals.

**Animation:** CSS `transition: transform 180ms ease, opacity 180ms ease` on the drawer panel and backdrop respectively — `transform: translateX(-100%)` closed, `translateX(0)` open. Explicitly not animating `left`/`width`/`margin` (forces layout recalculation every frame); `transform`/`opacity` stay GPU-composited. Respect `prefers-reduced-motion: reduce` — when set, `transition: none` (open/close becomes an instant state change, no sliding). No animation library — plain CSS, consistent with this app's existing convention (established during the Try On Library mobile rebuild earlier this session).

**Drawer width:** `min(320px, 85vw)` for both mobile and tablet — not the rail's 200px. A permanent rail at 200px is fine when it's always visible alongside content; a touch-driven overlay drawer at the same width feels cramped. At tablet widths (640px+), `85vw` is always ≥544px so this resolves to a flat 320px; the `85vw` cap only actually engages below ~376px, keeping a visible sliver of backdrop even on the narrowest phones so it still reads as an overlay rather than a full takeover.

**Full cleanup on leaving drawer mode:** if `useDrawerNavigation` transitions from `true` to `false` (resizing up past 1024px, or navigating away from `/sellio`) while the drawer happens to be open, the transition must fully clean up: the ESC listener and body-scroll-lock effects are gated on `isOpen && useDrawerNavigation` (not `isOpen` alone), so React's effect-dependency mechanism tears them down automatically the moment `useDrawerNavigation` flips; the backdrop and drawer panel stop rendering (they're only rendered when `useDrawerNavigation` is true); and the permanent rail reappears immediately with no backdrop, no lock, and no leftover state.

**z-index:** plain numbers, not a new token system (see rationale above) — backdrop at `1300`, drawer panel at `1301`. This sits above every existing modal in the app (highest currently is `1200`/`1201` on `profile-completion-modal`) and above the sticky per-page `TopBar` wrapper (`zIndex: 10` in, e.g., the pricing layouts) — an open drawer should cover everything until dismissed, matching how off-canvas nav drawers behave in every reference app cited above. The existing `/sellio` floating toggle button (`zIndex: 2000`) stays untouched and remains above the drawer, since it's the affordance for entering `/sellio`'s hidden-by-default mode, not for closing an open drawer.

## File plan

- **Create** `apps/catalogues-web/src/hooks/use-media-query.ts` — the generic single-query `useMediaQuery(query: string): boolean | null` primitive, extracted from the matchMedia/listener logic already inside `use-breakpoint.ts`.
- **Modify** `apps/catalogues-web/src/hooks/use-breakpoint.ts` — internal refactor to five calls to `useMediaQuery()` instead of its own inline `Object.entries`/matchMedia loop. Public API (`Tier | null`, same five tier names, same thresholds) is unchanged — this is a pure implementation-detail change, not a behavior change.
- **Modify** `apps/catalogues-web/src/components/app-shell.tsx` — compute `isMobileLayout` via the new `useMediaQuery('(max-width: 1023px)')` (not `useBreakpoint()`), derive `useDrawerNavigation`, wrap children in the new `SidebarProvider`, render the drawer + backdrop (instead of the current unconditional `sidebarVisible && <Sidebar />`) when `useDrawerNavigation` is true, keep the exact current rendering when it's false.
- **Create** `apps/catalogues-web/src/components/sidebar-context.tsx` — `SidebarProvider` (owns `isOpen` state, the route-change effect, the ESC listener, the body-scroll-lock effect, the drawer-width constant) + `SidebarContext` + `useSidebarContext()` hook exposing `{ isDrawerMode, isOpen, open, close, toggle }`.
- **Modify** `apps/catalogues-web/src/components/sidebar.tsx` — add an optional `onNavigate?: () => void` prop, called from each nav `<Link>`'s `onClick` (alongside the existing `prefetchRoute` call already there). No other changes — same markup, same nav items, same styling, whether rendered as the permanent rail or inside the new drawer wrapper.
- **Modify** `apps/catalogues-web/src/components/topbar.tsx` — consume `useSidebarContext()`; render a hamburger `<button>` (with the focus-restore effect described above) before the title, only when `isDrawerMode` is true. Zero changes to `TopBar`'s existing props (`title`/`subtitle`/`right`/`lead`) or to the phone link / `SupportButton` / `UserMenu` it already renders.

No page-level files change.

## Testing plan

No backend changes; no test runner in `apps/catalogues-web` (established convention this session) — verification is `pnpm --filter @tryme/web typecheck`/`lint`/`build`, plus manual checks:
- **Regression, ≥1024px:** small-laptop/laptop/desktop widths look and behave exactly as before — permanent rail, no hamburger anywhere, no drawer markup interactable.
- **Drawer mechanics, <1024px:** hamburger appears in `TopBar`; tapping opens the drawer with backdrop; tapping backdrop closes it; tapping a nav link closes it and navigates; browser back/forward while a drawer-opened page is active correctly leaves the drawer closed on the destination page; ESC closes it; body doesn't scroll while it's open; closing returns focus to the hamburger button.
- **Boundary resize, 1023↔1024:** open the drawer at 1023px, then resize to 1024px — verify the rail appears, the drawer/backdrop disappear, body scroll is unlocked, and the page is otherwise fully usable (no leftover overlay eating clicks). Then resize back from 1024px to 1023px — verify the drawer starts closed (not inheriting the open state from before the rail appeared). This single test exercises the "full cleanup on leaving drawer mode" requirement above and is exactly the kind of case responsive-shell bugs like to hide in.
- **`/sellio` regression:** existing floating toggle button still works exactly as before at any viewport width.
- Now that this is confirmed, re-verify the pricing page's `Mobile`/`Tablet` layouts (built earlier this session) actually render correctly with the full viewport width restored — this was the original motivating bug report.

## Open follow-ups (explicitly out of scope here)

- `TopBar`'s own right-side content (Support/phone/`UserMenu`) collapsing into a mobile overflow menu.
- `useBreakpoint()` → richer `useViewport()` API.
- Continuing the per-page `useBreakpoint()` + tier-layout rollout to other pages (studio, catalogues, etc.) — sequenced *after* this ships, so those pages build on a shell that already gives them the full viewport instead of fighting it.
