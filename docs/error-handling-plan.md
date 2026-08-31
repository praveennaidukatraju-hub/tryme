# Error Handling & Observability Plan

Status: **not started** — this is a plan to execute later, phase by phase.
Progress tracking lives in `docs/error-handling-progress.md` (created in Phase 0).

## Why

The `/v1/dev/*` surface got proper error documentation and error messages in
`fbb31cef` (PR #89). That work exposed how much of the same gap exists everywhere else:
errors are thrown consistently enough to work, but they are not **queryable**, not
**correlatable**, and not **actionable** — neither in Grafana nor in the admin panel.

This plan generalises that fix across the codebase.

## Findings this plan is built on

All numbers were measured on `main` at the time of writing (2026-07-30). Re-measure
before starting — they are the baseline the progress doc tracks against.

### Error vocabulary has drifted

`apps/api/src/` contains **555 `AppError(...)` call sites** across **44 distinct codes**,
with clear synonym pairs that make grouping by code unreliable:

| Overlapping codes | Counts |
|---|---|
| `UNAUTH` / `UNAUTHORIZED` | 66 / 10 |
| `VALIDATION` / `INVALID` / `BAD_REQUEST` | 67 / 19 / 4 |
| `INSUFFICIENT_CREDITS` / `INSUFFICIENT` | 5 / 1 |
| `BAD_CATALOG` / `BAD_UPLOAD` / `BAD_CATEGORY` / `BAD_STATE` / `BAD_SLUG` / `BAD_STYLE` | 20 / 16 / 4 / 3 / 2 / 1 |

There is no central registry of valid codes, so nothing prevents the next new code
from being a 45th spelling of an existing one.

### The API error handler under-reports real failures

`apps/api/src/server.ts:237`:

- The `err instanceof AppError` branch logs at **`warn`** and **never calls
  `Sentry.captureException`** — regardless of status. So `ENQUEUE_FAIL` (503, "queue
  unavailable", 6 call sites) — Redis being down, i.e. a full outage of job creation —
  is a `warn` line and is invisible in Sentry. **Severity must be driven by
  `statusCode`, not by whether the error is an `AppError`.**
- The validation branch logs `body: _req.body` — the entire request body into Loki.
  `packages/logger` redaction is key-name-based (`password`, `token`, `*.secret`, …),
  so any field it does not know about (email, phone, address, hint text) ships to
  Grafana Cloud in plaintext. **Security-relevant; fix in the same phase.**
- No `x-request-id` is returned to clients. A user reporting "it failed" cannot be
  tied to a log line; `reqId` exists in pino output but never leaves the server.

### `AppError` carries no structured context

`apps/api/src/lib/errors.ts` is `{ code, statusCode, message }` and nothing else. There
is no place to attach the ids/state that would explain *why* it fired, so that detail
either ends up interpolated into the message string (unqueryable) or is lost.
`apps/chatbot/src/lib/errors.ts` is a byte-identical duplicate class.

### Grafana cannot group by error code

`infra/observability/alloy.alloy`'s `stage.json` extracts only `level`, `service`,
`jobId`, `userId`. The `code`, `statusCode`, `url`, and `reqId` fields **are present in
the pino line but are not extracted**, so every "which error is spiking" question needs
a full-text regex across raw log lines instead of a field filter.

There is also no `errors_total` metric — `packages/observability/src/metrics.ts` has 15
metrics, none of them error-code-aware. `http_request_duration_seconds{status=...}`
gives status class only, so "5xx rate is up" is answerable but "which code" is not.

`infra/observability/dashboards/tryme-overview.json` has no error panels beyond HTTP
5xx rate, and the alert table in `docs/observability.md` has nothing that fires on a
specific code spiking.

### Three divergent client error modules

- `apps/catalogues-web/src/lib/errors.ts` — `ApiError`, `httpStatusMessage`,
  `downloadErrorMessage`, `networkError`
- `apps/admin-web/src/lib/data.ts:430` — its own `ApiError`, `apiErrorBodyMessage`,
  `uploadErrorMessage`
- `apps/shopify/src/` — a third variant

Same job, three copies, divergent user-facing copy, no shared package.

---

## Phase 0 — Create the progress doc

Create `docs/error-handling-progress.md` before touching code. It is the resume point
for every later phase and the answer to "which folder is done".

Structure it as:

```markdown
# Error Handling Rollout — Progress

Plan: `docs/error-handling-plan.md`
Baseline measured: <date> — 555 AppError sites / 44 codes in apps/api/src

## Phase status
| Phase | Scope | Status | Notes |
|-------|-------|--------|-------|
| 0 | Progress doc | ✅ done | |
| 1 | packages/errors foundation | ⬜ not started | |
| ... | | | |

## Folder sweep (Phase 4)
| Folder | AppError sites (baseline) | Status | PR |
|--------|--------------------------|--------|-----|
| apps/api/src/modules/admin | 132 | ⬜ | |
| apps/api/src/modules/merchant | 111 | ⬜ | |
| apps/api/src/modules/jobs | 69 | ⬜ | |
| apps/api/src/modules/shopify | 55 | ⬜ | |
| apps/api/src/modules/auth | 42 | ⬜ | |
| apps/api/src/modules/dev | 41 | ✅ done | #89 (error schemas only) |
| apps/api/src/plugins | 36 | ⬜ | |
| apps/api/src/modules/kiosk | 26 | ⬜ | |
| apps/api/src/lib | 21 | ⬜ | |
| apps/api/src/modules/results | 7 | ⬜ | |
| apps/api/src/modules/payments | 6 | ⬜ | |
| apps/api/src/modules/backgrounds | 6 | ⬜ | |
| apps/api/src/modules/models | 1 | ⬜ | |
| apps/api/src/modules/credits | 1 | ⬜ | |
| apps/api/src/modules/catalog | 1 | ⬜ | |
| apps/chatbot/src | 9 | ⬜ | |

## Decisions made
(append as you go — especially any code-vocabulary rulings, so later folders stay consistent)

## Open questions
```

Add a dated entry to `docs/progress.md` per the repo convention, pointing at this doc.

---

## Phase 1 — Foundation: `packages/errors`

**Why a new package and not `packages/types`:** CLAUDE.md states `packages/types` is
"Pure Zod schemas only — single source of truth for request/response shapes". `AppError`
is a runtime class, so it does not belong there. `packages/errors` is a new workspace
package consumed by `api`, `chatbot`, and `dispatcher`.

1. Define the canonical error-code registry as a const object / union type. Group by
   family and pick one winner per synonym set. Proposed rulings (record them in the
   progress doc's Decisions section):
   - `UNAUTH` wins over `UNAUTHORIZED` (66 vs 10 — fewer edits)
   - `VALIDATION` wins over `INVALID` and `BAD_REQUEST`
   - `INSUFFICIENT_CREDITS` wins over `INSUFFICIENT`
   - keep the `BAD_*` family **distinct** — they are genuinely different resources
     (catalog vs upload vs slug), which is exactly the granularity Grafana wants
2. Extend `AppError` with an optional structured `context` (a flat
   `Record<string, string | number | boolean | null>`) and an optional `cause`. Flat and
   primitive-only so it maps cleanly onto Loki structured metadata and cannot smuggle a
   whole request body in.
3. Add a `severity` derivation helper: `statusCode >= 500` → `error`, `429` → `warn`,
   other `4xx` → `warn` but never Sentry. Single source of truth for both the API and
   chatbot handlers.
4. Keep the old `code`/`statusCode`/`message` constructor signature working so the
   555 existing call sites compile unchanged — Phase 4 migrates them incrementally.
   **This phase must not require a big-bang edit.**
5. Delete `apps/chatbot/src/lib/errors.ts` and re-export from the new package.

Tests: unit tests for the registry (no duplicate codes, every code has a default
status), severity derivation, and `context` flattening rejecting nested objects.

---

## Phase 2 — API + chatbot error handler hardening

`apps/api/src/server.ts:237` and `apps/chatbot/src/server.ts:43`.

1. Drive log level and Sentry from `statusCode`, not from error class — so an `AppError`
   with 503 logs at `error` and reaches Sentry. This is the single highest-value fix in
   the plan.
2. Log a fixed field set on every error: `code`, `statusCode`, `route` (the matched
   Fastify route template, not the raw URL — same cardinality reasoning as
   `plugins/metrics.ts`), `reqId`, plus `err.context` spread under a `ctx` prefix.
3. **Stop logging `req.body`.** Replace with the validation issue paths only
   (`err.validation[].instancePath`) — that says *which field* failed without shipping
   its value.
4. Add `x-request-id` on every response (echo an inbound one if present, else `reqId`),
   and include it in the error body as `error.requestId`. This is what makes an admin
   able to act on a user-reported failure.
5. Increment the new `errors_total` counter (Phase 3) from the handler.

Tests: assert 5xx `AppError` reaches the Sentry hook (spy) while 4xx does not; assert no
request-body values appear in captured log output for a validation failure; assert
`x-request-id` round-trips.

---

## Phase 3 — Make it queryable (Grafana / Loki / Prometheus)

Do this **before** the Phase 4 sweep, so the dashboards can measure the sweep's effect.

1. `packages/observability/src/metrics.ts` — add:
   ```
   errors_total{service, code, status, route}
   ```
   Keep `route` as the matched template, and be deliberate about cardinality: codes are
   bounded by the Phase 1 registry, routes by Fastify's template set.
2. `infra/observability/alloy.alloy` — extend `stage.json` to extract `code`,
   `status_code`, `route`, `req_id`. Promote **only `code`** to a Loki label (bounded by
   the registry); keep `req_id`/`route` as structured metadata to avoid label explosion.
   The existing comment in that file already states this rule — follow it.
3. `infra/observability/dashboards/tryme-overview.json` — add panels:
   - top error codes by rate (`topk(10, sum by (code) (rate(errors_total[5m])))`)
   - error rate by route
   - 5xx-only code breakdown
   - a Loki logs panel filtered to `level="error"` with `code` shown
4. `docs/observability.md` — add alerts for: any 5xx code sustained above threshold,
   `ENQUEUE_FAIL` present at all (queue down = page immediately), and
   `INSUFFICIENT_CREDITS` spiking (business signal, not an outage).
5. Verify locally with the procedure already in `docs/observability.md` ("Testing
   locally") before shipping.

---

## Phase 4 — Folder-by-folder sweep

This is the long tail: migrate call sites onto the registry, add `context` where the
message currently interpolates ids, and add 4xx/5xx response schemas to routes the way
`apps/api/src/modules/dev/` now does.

**Work one folder per PR**, in this order (highest count first — biggest Grafana
signal-quality win earliest, and each is independently shippable):

1. `apps/api/src/modules/admin` (132)
2. `apps/api/src/modules/merchant` (111)
3. `apps/api/src/modules/jobs` (69)
4. `apps/api/src/modules/shopify` (55)
5. `apps/api/src/modules/auth` (42)
6. `apps/api/src/plugins` (36)
7. `apps/api/src/modules/kiosk` (26)
8. `apps/api/src/lib` (21)
9. `apps/api/src/modules/{results,payments,backgrounds,models,credits,catalog}` (16 total — one PR)
10. `apps/chatbot/src` (9)

`apps/api/src/modules/dev` (41) is **partially done** — error response schemas landed in
PR #89, but its call sites still use the old vocabulary; revisit after Phase 1.

Per folder, the checklist is:
- [ ] every `AppError` code is in the registry (no ad-hoc strings)
- [ ] ids/state moved from message interpolation into `context`
- [ ] routes declare their real 4xx/5xx in the OpenAPI `response` map
- [ ] tests updated; full API suite green
- [ ] progress doc row flipped to done with the PR link

**Note on scope:** only `apps/api/src/modules/dev/` has 4xx/5xx response schemas today
(1 of 47 route files with OpenAPI schemas). Admin/merchant/shopify routes are internal
or first-party, so documenting their error responses is lower value than the public dev
API — treat the schema work as *optional* for those folders and the code/context work as
mandatory. Decide per folder and record it.

---

## Phase 5 — Shared client error module

Collapse the three copies into one package (`packages/client-errors`, or extend
`packages/types` only if it stays schema-only and the runtime bits live elsewhere):

- one `ApiError` class that surfaces `code`, `status`, `message`, and the new `requestId`
- one `httpStatusMessage` map — reconcile the divergent copy between
  `catalogues-web` and `admin-web` deliberately, do not just pick one at random
- keep the specialised variants (`downloadErrorMessage`, `uploadErrorMessage`) as
  overrides layered on the shared base

Migrate `apps/catalogues-web`, `apps/admin-web`, `apps/shopify` onto it. Per-app PRs.

`apps/admin-mobile` is **out of scope** — paused per CLAUDE.md.

---

## Phase 6 — Admin-side error visibility

Two separable things; do (a) first, and treat (b) as a real product decision.

**(a) Better error surfacing in the existing UI (mechanical).**
`apps/admin-web` already has `ToastStack`. Make every failed mutation show the server's
`code` + `requestId` alongside the human message, so an admin can quote the request id
into Grafana. Audit for swallowed errors and add an `ErrorBoundary` at the route level.

**(b) An admin page that lists recent errors (needs a decision).**
Options, in increasing cost:
- **Link out to Grafana** — add deep links from the admin panel into pre-filtered Loki
  queries. Cheapest, no new storage, keeps one source of truth. **Recommended.**
- **Read from Sentry's API** — good for 5xx triage, nothing for 4xx.
- **Persist errors to Postgres** — a new table + retention policy. Only justified if
  admins need this without Grafana access. Note `job_events` already exists for
  job-scoped debugging; do not duplicate it.

Decide before building. Record the ruling in the progress doc.

---

## Phase 7 — Dispatcher parity

`apps/dispatcher` has Sentry but no HTTP error handler (it is a stream consumer, not an
HTTP service). Bring it onto `packages/errors` for consistency, make sure terminal job
failures log the same `code` field shape so `errors_total` and the Loki `code` label
cover dispatcher failures too, and confirm the credit-refund path's failures are
`error`-level and Sentry-visible.

---

## Constraints that apply to every phase

- **Never touch production data or run migrations against prod** — see the CLAUDE.md
  invariant and the 2026-07-27 incident. If a phase needs a schema change (only Phase 6
  option 3 does), it goes through `db:generate` → PR → CI/CD → `db:migrate:prod`.
- **No `console.log`** in committed code (11 `console.error` sites exist across apps —
  fold them into the sweep).
- Keep `/metrics` off the public internet (`docs/observability.md`).
- Don't let the registry become a cardinality bomb: codes are labels, ids are not.
- Update `docs/progress.md` after each phase, and flip the row in
  `docs/error-handling-progress.md` in the **same** PR as the work.

## Verification per phase

- `pnpm typecheck` clean
- `pnpm lint` clean on touched files
- `pnpm --filter @tryme/api test` — 323/323 baseline, must not regress
- For Phase 3: confirm in Grafana that `code` is filterable as a label and the new
  panels populate, using the local test procedure in `docs/observability.md`
