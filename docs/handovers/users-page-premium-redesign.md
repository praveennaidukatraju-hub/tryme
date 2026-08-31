# Handover: Users page (list + detail) premium UI/UX rebuild

**For:** antigravity CLI (implementer)
**From:** Claude review — reverified `apps/admin-web/src/pages/UsersPage.tsx` per user request ("reverify all the UI and UX of the users page and details page in admin-web, I don't think the current one looks like premium UI, take the liberty to make it look premium and bring value in production for the admin managing users and merchants").
**Scope:** `apps/admin-web/src/pages/UsersPage.tsx` only (list view + user detail view, same file). No API/backend changes — the data contract (`User`/`UserMerchant` in `apps/admin-web/src/types.ts`, `/admin/users` list+detail, `/admin/merchants/*`) is correct and unchanged.

---

## 1. Root cause of "not premium"

Every other admin page (`DashboardPage.tsx`, `WorkersPage.tsx`, `CatalogPage.tsx`, etc.) is built directly on the shared design system in `apps/admin-web/src/styles/tokens.css` — `.card`, `.card-head`/`.card-body`, `.stat-grid`/`.stat`, `.badge`, `.tbl`/`.table-wrap`, `.modal`, `.field`, `KV.tsx`. No page injects its own `<style>` block. That shared system already has the "premium" feel (oklch palette, consistent radii via `--r`/`--r-lg`/`--r-xl`, consistent shadows via `--shadow-md`/`--shadow-lg`, dark-mode tokens).

`UsersPage.tsx` is the one outlier. It renders:

```tsx
<style>{injectedStyles + refinedStyles}</style>
```

on every render, where `injectedStyles` (~334 lines) is a first-pass bespoke design (`.clean-card`, `.premium-badge`, `.premium-table`, `.premium-stats-strip`, `.clean-kv-grid`...) and `refinedStyles` (~98 lines, minified) is a *second pass that overrides the first* via higher-specificity selectors like `.users-page-container .premium-search input`. This is a specificity war against itself, not a design system — most of `injectedStyles`' declarations are dead, overridden by `refinedStyles` two hundred lines later, and a few are **not** overridden and silently ship stale hardcoded colors (see §2.3). This is why it reads as visually "off" from the rest of the app: it's a parallel, half-finished design language, not a bug in any one color or spacing value.

**The fix is architectural, not cosmetic:** delete both style blocks, rebuild the page on tokens.css primitives like every sibling page does. This also fixes the dark-mode bugs and shrinks the file substantially (current file is 1585 lines, ~430 of which are CSS strings).

---

## 2. Concrete defects found

### 2.1 Duplicated primitives (delete, reuse instead)
| Reinvented in UsersPage | Already exists, used everywhere else |
|---|---|
| `.clean-card`, `.clean-card-header`, `.clean-card-title` | `.card`, `.card-head`, `.card-head h3` |
| `.premium-badge` + `.admin`/`.merchant`/`.oauth`/`.tier` variants | `.badge` + `.success`/`.warn`/`.danger`/`.info`/`.accent`/`.dot` variants (see `StatusBadge.tsx` for the pattern) |
| `.premium-table`, `.premium-table-container` | `.tbl` / `.table-wrap` (used by every other list page) |
| `.clean-kv-grid`, `.clean-kv-item`, `.clean-kv-key`, `.clean-kv-val` | `KV.tsx` component + `.kv`/`.kv-grid` — **`KV.tsx` is imported nowhere in this file even though it exists for exactly this purpose** |
| `.premium-stats-strip`, `.premium-stat-item` | `.stat-grid`, `.stat` (Dashboard's stat cards additionally support hover + delta indicators — Users' hero stats are flat with no interactivity) |
| `.clean-field`, `.clean-label`, `.clean-input` | `.field`, `.field label`, `.input`/`.select` |

### 2.2 Redundant DOM just to work around a CSS decision
In the list table, each row renders the admin/oauth/merchant badges **twice** — once inside `.user-cell-name` (then hidden via `.user-cell-name>.premium-badge{display:none}` in `refinedStyles`), and once in the separate "Access" column. That's dead JSX kept alive only because the CSS override needed something to hide. Delete the badges from the name cell; only render them in the Access column.

### 2.3 Dark-mode bugs from hardcoded oklch literals
`injectedStyles` hardcodes literal color values instead of using CSS variables in several places that `refinedStyles` never re-overrides, e.g. (lines ~332-348 of current file):
```css
.premium-badge.admin { background: oklch(0.95 0.02 340); color: oklch(0.4 0.1 340); }
.premium-badge.merchant { background: oklch(0.95 0.04 145); color: oklch(0.35 0.1 145); }
.premium-badge.oauth { background: oklch(0.95 0.01 240); color: oklch(0.4 0.1 240); }
```
These don't shift under `[data-theme="dark"]` the way `--success-soft`/`--info-soft`/`--accent-soft` etc. do in tokens.css. Result: badges look wrong (too light / low contrast) in dark mode. Using `.badge.success`, `.badge.info`, `.badge.accent` instead fixes this for free since those already have dark-mode variants defined.

### 2.4 Inconsistent container chrome
The list view stacks three separately-boxed elements with mismatched corners and shadows: `.users-toolbar` (search + filter pills, `border-radius: 12px`), `.premium-table-container` (table, `border-radius: 12px`), `.users-pager` (pager, `border-radius: 0 0 12px 12px`, negative `margin-top: -1px` to fake a seam). Every other list page in the app (see `.table-wrap` usage) uses **one** bordered container that holds filters + table + pager as a single visual unit. Rebuild it that way — it's both simpler code and looks more deliberate.

### 2.5 Inline `style={{...}}` scattered through JSX
Dozens of one-off `style={{ fontSize: 14, color: 'var(--muted)' }}`-style props (loading states, recent-jobs table cells, modal field spacing). Every other page uses classes for this. Move these into the stylesheet or reuse existing utility classes (`.mono`, `.muted`, `.sub`, `.lede`) already defined in tokens.css.

### 2.6 Grant-merchant flow is two steps for no reason
"Grant Access" modal only collects `companyName`; contact name/phone/business address are left blank (with placeholder defaults set server-side) and the admin is expected to immediately open "Edit" afterward to fill them in. Since the Edit modal already exists and collects exactly those three fields, just merge them into one modal with `companyName` required and the rest optional — removes an unnecessary extra click for the *common* path (admin already knows the contact details when granting).

### 2.7 No visual treatment for suspended users in the list
A banned/suspended user shows only a small `StatusBadge` in the last column — easy to miss when scanning a long list. Dim the row (e.g. reduced opacity or muted text) when `u.isBanned`, consistent with how `.inactive-overlay`/`.stat.alert` are used elsewhere in the app to flag attention-worthy state.

### 2.8 Merchant credit balance invisible in list view
When "Merchants" filter is active, the list still shows the *user's own* app credit balance/tier — not merchant catalogue credits, which is the number an admin filtering to merchants actually cares about. Not asking to change the API (merchant credit balance is already returned in `user.merchant.creditBalance` per `types.ts` — confirm it's included in the list endpoint's `isMerchant`/`merchant` join before relying on it; if the list endpoint only returns `isMerchant: boolean` without the nested `merchant` object, this is a nice-to-have, not a blocker — skip if it requires an API change).

---

## 3. What must NOT change (functional contract)

Preserve all current behavior exactly — this is a visual/structural rebuild, not a feature change:

- **List**: search (debounced via `handleSearch`→`setPage(0)`), merchants-only filter toggle, column sort (`Th` component, `sortKey`/`sortDir`), pagination (`Pager`), row click → `openDetail`.
- **Detail**: back button, hero (avatar/name/email/badges), credit adjust (grant/deduct modal with reason), grant/revoke admin (`SUPER_ADMIN`-gated), suspend/unsuspend with confirm modal, tier change (`selectedTier` + save), device limit change (`selectedMaxDevices` + save, 1-50 validated), merchant access card (empty state → grant modal; populated state → KV display + edit modal + activate/revoke toggle), account details facts (phone, auth method, joined, last job, user ID, ban reason if banned), recent jobs mini-table (status badge, created date, duration).
- All existing `apiFetch` calls, endpoints, and request/response shapes — untouched.
- `Props` interface (`onNav`, `toast`) — untouched.
- Keep using `Icon.*`, `NameAvatar`, `Pager`, `StatusBadge`, `Th` — these are fine, reuse as-is. Start using `KV`/`KV.tsx` for the "Account details" facts and merchant KV grid instead of hand-rolled markup.

## 4. What "premium" should mean here (design direction, not a constraint)

You have creative liberty on exact layout, per the user's instruction — the one hard requirement is **consistency with the rest of admin-web**, since that's what's currently broken. Concretely:
- Zero injected `<style>` blocks. Any page-specific classes go in `tokens.css` (or a co-located `.css` module if the codebase supports it — check for precedent first; if none exists, append scoped rules to `tokens.css` under a clearly-commented `/* --- users page --- */` section, following the pattern already used there for `/* --- settings page --- */` etc.).
- Reuse `.card`, `.stat`/`.stat-grid`, `.badge`, `.tbl`/`.table-wrap`, `.modal`, `.field`, `KV` wherever the existing primitive covers the need. Only add new CSS for things genuinely unique to this page (e.g. the detail hero layout, if kept).
- One bordered container for the list toolbar+table+pager (§2.4).
- Dim/flag suspended rows (§2.7).
- Single-step merchant grant (§2.6).
- No duplicate badge rendering (§2.2).

## 5. Verification before handing back

- `pnpm --filter @tryme/admin typecheck` and `pnpm --filter @tryme/admin build` clean.
- `pnpm --filter @tryme/admin dev`, manually walk: list search/filter/sort/paginate → open a normal user → open an admin user (as SUPER_ADMIN, verify grant/revoke admin buttons appear correctly) → open a merchant user → grant merchant access to a non-merchant user → edit merchant details → revoke/reactivate → adjust credits (grant + deduct) → suspend/unsuspend → change tier → change device limit. Confirm dark mode (`[data-theme="dark"]` toggle, see Settings page) doesn't show any washed-out/wrong-contrast badges.
