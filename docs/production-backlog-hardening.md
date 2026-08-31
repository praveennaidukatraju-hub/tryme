# Production Readiness Report — Job Processing, Queue & Credit Integrity

> **Audience:** CTO / engineering, for triage and fix assignment.
> **Status:** All code-fixable items resolved. Two items blocked on product decisions (#8, #9). Two items blocked on ops/design input (#4, #5). Three items deferred. Nothing open for implementation.
> **Scope:** the try-on job pipeline (creation → enqueue → dispatch → ComfyUI →
> result fetch), the 3-tier priority queue, and credit accounting.
> **Last updated:** 2026-06-30.

---

## 1. Context & the scenario we're designing for

Before production we need confidence that a surge — e.g. **100 users** each submitting
1 garment × 4 poses = **400 jobs** — is processed and **fetched correctly**, not just
quickly.

- ComfyUI takes **~35s/image**.
- We run **3 fixed monthly GPUs** (always-on, no autoscaling). They cost the same idle
  or busy, so we run all 3 permanently. Dispatcher concurrency = number of registered
  workers. No idle-scaling logic is needed.
- At 3 GPUs the backlog drains at **~270 images/hr (~90 min for the 400th image)**. This
  is GPU-bound; only more GPUs or faster per-image generation change aggregate
  throughput. **Wait time is a known, accepted constraint — it is not what this report
  is about.**

This report is about **correctness and reliability under a large backlog**: will every
job (including the 100th user's) be created, queued, processed, and fetched without
losing money, getting stuck, or starving other users.

### 1.1 What is already solid (no action needed)

- **The pull-based design protects against timeout failures.** The dispatcher consumer
  only reads a job from Redis when a GPU slot is free
  (`apps/dispatcher/src/stream/consumer.ts`, `waitForSlot`). So a queued job sits in the
  stream as an unread entry with **zero timeout pressure**; all ComfyUI timeouts
  (15s submit, 300s completion, 30s history, 120s download) start only **after** a
  worker is claimed. A job can wait 90 min and still get a full fresh budget. **The
  original "will the 100th user's image time out?" worry is unfounded.**
- **Result fetch is durable.** `apps/catalogues-web/.../catalogues/[id]/page.tsx` loads job state
  from the DB (`GET /v1/catalogues/:id`), **polls** while any job is non-terminal
  (`refetchInterval`), and also receives live SSE updates with auto-reconnect. Results
  live in Postgres + R2, so closing the tab or waiting 90 min loses nothing.
- **The happy path is well-instrumented** (Prometheus counters for jobs, credits,
  comfy duration; structured pino logs with `jobId`/`userId`).

The issues below are in the **failure, recovery, scheduling, and cancellation paths.**

---

## 2. Issue tracker (summary)

| # | Issue | Severity | Area | Status |
|---|-------|----------|------|--------|
| 12 | Credits NOT refunded on pre-flight failures | **High (money)** | Credits | ✅ Fixed |
| 13 | Zombie jobs after dispatcher crash mid-processing | **High** | Recovery | ✅ Fixed |
| 8 | Priority scheduler is starvation-prone | **High** | Scheduling | 🔵 Blocked — product decision needed |
| 9 | Priority/tier is permanent after one purchase | **High (business)** | Scheduling | 🔵 Blocked — product decision needed |
| 1 | Redis stream unbounded growth | High | Infra | ✅ Fixed |
| 2 | Adding a GPU is unreliable (frozen concurrency + stale script) | High (ops) | Ops | ✅ Fixed |
| 14 | Refund and state transition not atomic | Medium | Credits | ✅ Fixed |
| 15 | No-worker requeue loops forever, loses position | Medium | Recovery | ✅ Fixed |
| 16 | No cancel path for queued/active jobs | Medium | UX/cost | ✅ Fixed |
| 3 | Stale-job reclaim only runs at boot | Medium | Recovery | ✅ Fixed |
| 4 | SSE Redis connection fan-out under backlog | Medium | Scale | 🔵 Blocked — needs prod Redis maxclients + peak tab count |
| 5 | Input retention must exceed max queue wait | Medium | Infra | 🔵 Blocked — ops must confirm R2 lifecycle ≥ 24h |
| 17 | No idempotency key on job submission | Low–Med | Credits | ✅ Fixed |
| 10 | `jobs.priority` boolean is lossy | Low | Scheduling | ✅ Fixed |
| 11 | `jobs:low` queue depth never measured | Low | Observability | ✅ Fixed |
| 6 | No per-user fairness within a tier | Low | Scheduling | 🔴 Deferred |
| 7 | No ComfyUI batching | Low (future) | Throughput | 🔴 Deferred |
| S1 | Credit cost is client-declared & decoupled from real output | **High (money)** | Security | ✅ Fixed |
| S2 | Payment verify/webhook can double-credit (race + no idempotency) | **High (money)** | Security | ✅ Fixed |
| S3 | App-level (non-atomic) idempotency on credits/refunds | Medium | Security | ✅ Fixed |
| S4 | Client-controlled compute (steps/dims) at flat price | Medium | Security | ✅ Fixed (steps capped at 30; per-tier limit deferred until step pricing decided) |
| S5 | Free-trial credits farmable via disposable emails | Low (mitigated) | Security | 🟡 Mitigated — defer unless abuse observed |
| S6 | `lowerCatalogId`/`shoeCatalogId`/`garmentTypeId` not validated at creation | Low | Security | ✅ Fixed |
| S7 | No idempotency key on job submission (= #17) | Low–Med | Security | ✅ Fixed |

Severity key: **High** = correctness/money/availability risk that the backlog scenario
actively triggers. **Medium** = real reliability/UX gap under load. **Low** =
cleanup / future optimization.

---

## 3. Critical issues (correctness & money)

### Issue 12 — Credits are NOT refunded on pre-flight failures  *(money bug)*

**Severity:** High (money) · **Area:** Credits · **Files:**
`apps/dispatcher/src/job/processor.ts`, `apps/api/src/modules/jobs/create.ts`

**What's wrong**
Credits are deducted when the job is **created** (`create.ts:221`):

```ts
await atomicDeduct(tx as unknown as DB, userId, COST, job.id); // reason: JOB_DISPATCH
```

The dispatcher has two failure handlers, and they behave differently:

- `handleFailure` (`processor.ts:758`) — used for errors thrown **during** processing
  (ComfyUI/R2 errors). On terminal failure it **refunds** credits (idempotently).
- `markFailed` (`processor.ts:798`) — used for **pre-flight resolution** failures. It
  only marks the job `FAILED` and ACKs the message. **It never refunds:**

```ts
async function markFailed(cfg, jobId, userId, stream, messageId, errorCode, log, startedAt) {
  const { db, redis, pub } = cfg;
  await transitionJob(db, pub, jobId, userId, 'FAILED', { errorCode }, log);
  await redis.xack(stream, 'dispatcher-cg', messageId);
  recordJobOutcome('failed', startedAt);
  // ← no credit refund
}
```

`markFailed` is the handler for **every** pre-flight error code: `NO_INPUTS`,
`MISSING_MODEL_INPUTS`, `CATALOG_NOT_FOUND`, `NO_FACE_IMAGE`, `NO_WORKFLOW`.

**Impact**
A user is **charged credits for a job that produced no output and was never the user's
fault.** This is a direct money/integrity bug and a likely support/chargeback driver.

**How the backlog triggers it**
Validation passes at creation, but the job may run ~90 min later. If an admin deletes or
deactivates the selected pose / face / background / workflow template in that window, the
dispatcher resolves the now-missing asset to `CATALOG_NOT_FOUND` / `NO_WORKFLOW` /
`NO_FACE_IMAGE` → `markFailed` → **no refund**. The longer the queue, the larger this
window, and the more likely an admin edit lands inside it.

**Recommended fix**
Make `markFailed` refund credits idempotently, using the same pattern as `handleFailure`
(check `creditLedger` for an existing `JOB_FAIL_REFUND` for the `jobId`, then credit +
ledger insert in one transaction). Consider routing both handlers through a single shared
"terminate job (refund, mark FAILED, ack)" function so the two paths can never diverge
again.

---

### Issue 13 — Zombie jobs after a dispatcher crash mid-processing

**Severity:** High · **Area:** Recovery · **Files:**
`apps/dispatcher/src/job/processor.ts`, `apps/dispatcher/src/stream/recovery.ts`

**What's wrong**
As soon as `processJob` starts, it moves the job out of `QUEUED`:

```ts
await transitionJob(db, pub, jobId, userId, 'PREPROCESSING', {}, jobLog); // processor.ts:237
```

The only thing that rescues a job after that point is the in-process `handleFailure`
(the `try/catch`). If the **dispatcher process crashes** mid-job (OOM, deploy, host
reboot), the in-flight Redis message is left in the consumer group's Pending Entries
List (PEL). On restart, `recoverPendingJobs` reclaims it and calls `processJob` again —
but `processJob` immediately bails because the job is no longer `QUEUED`:

```ts
if (job.status !== 'QUEUED') {
  jobLog.warn({ status: job.status }, 'job not QUEUED — skipping');
  await redis.xack(stream, 'dispatcher-cg', messageId); // ← ACK + abandon
  return;
}
```

**Impact**
The job is **stuck in `PREPROCESSING`/`GENERATING` forever** — non-terminal, never
refunded, and the user's UI shows a **perpetual progress bar** (the page polls the DB,
which never changes). Every dispatcher crash during a busy period can orphan up to
`concurrency` (3) jobs this way.

**How the backlog triggers it**
A 90-min drain means the dispatcher is continuously busy; any crash/deploy/restart in
that window orphans whatever was in flight.

**Recommended fix**
On reclaim, recovery (or the `status !== 'QUEUED'` branch) must **not silently ACK and
drop** a non-terminal job. Instead: reset it to `QUEUED` and re-enqueue (counting it as a
retry attempt so it can't loop forever), or fail+refund it. Couple this with Issue 14 so
replay is fully idempotent.

---

### Issue 14 — Refund and state transition are not atomic

**Severity:** Medium · **Area:** Credits · **File:**
`apps/dispatcher/src/job/processor.ts`

**What's wrong**
In `handleFailure`, the terminal path does three separate, non-atomic steps:

```ts
await db.transaction(async (tx) => { /* refund credits */ });          // :760
await transitionJob(db, pub, jobId, userId, 'FAILED', { errorCode }, log); // :778
await redis.xack(stream, 'dispatcher-cg', messageId);                   // :779
```

A crash **between** the refund transaction and `transitionJob` leaves the job
**refunded but not marked `FAILED`**. On restart it is reclaimed and — per Issue 13 —
skipped because it's non-terminal, so it stays a zombie even though the money was already
returned.

**Impact**
Inconsistent state: refunded-but-not-failed jobs, possible double-refund risk if recovery
later retries the same job without idempotency.

**Recommended fix**
Combine refund + status update into a single DB transaction, and make the whole terminal
handler idempotent on replay (the refund already checks the ledger; the status update
should converge the same way). Only ACK after the DB transaction commits.

---

## 4. Priority scheduler issues

> The 3-tier priority system (`jobs:priority` / `jobs:normal` / `jobs:low`, selected from
> `credit_plans.queueStream` via `users.tier` in `create.ts`) is **functionally correct
> for ordering** but **not fully production-grade.**

### Issue 8 — Starvation: strict priority with no anti-starvation

**Severity:** High · **Area:** Scheduling · **File:**
`apps/dispatcher/src/stream/consumer.ts`

**What's wrong**
`readOne` checks the three streams in fixed order and only looks at a lower tier when the
higher one is empty:

```ts
// 1. priority — instant, no block
// 2. normal   — instant, no block (only if priority empty)
// 3. low       — BLOCK 2s   (only if priority & normal empty)
```

There is **no aging, no reserved capacity, and no weighting.** Under sustained
higher-tier load, `normal` and `low` jobs can be delayed **indefinitely**.

**Impact**
During the 400-job surge, if even a handful of priority-tier users keep submitting,
normal/low users may never get a GPU. With only 3 GPUs the effect is severe — all 3 slots
can be permanently occupied by priority work.

**Recommended fix (choose one)**
- **Reserved capacity:** dedicate ≥1 of 3 GPUs to non-priority work.
- **Weighted round-robin:** serve in a fixed ratio (e.g. 3 priority : 1 normal : 1 low).
- **Aging:** promote a job's effective priority the longer it waits.

No preemption is required (35s jobs can't be interrupted mid-generation).

---

### Issue 9 — Priority/tier is permanent after a single purchase

**Severity:** High (business) · **Area:** Scheduling · **File:**
`apps/api/src/modules/payments/routes.ts`

**What's wrong**
`users.tier` is set on successful payment and **never downgraded**:

```ts
await tx.update(schema.users)
  .set({ tier: payment.planId, updatedAt: new Date() })
  .where(eq(schema.users.id, req.userId));   // verify path :245
// ...same in the webhook path :370
```

Plans are **one-time Razorpay credit top-ups**, not subscriptions. There is no expiry and
no link to "credits remaining." So a user who buys a priority plan **once keeps priority
forever**, even after their credits hit zero.

**Impact**
The priority cohort only ever grows, which directly worsens Issue 8 (starvation) over
time. It is almost certainly not the intended business rule.

**Open question (needs a product decision)**
What should grant priority?
1. Only while `credits > 0`?
2. For N days after purchase?
3. Only while on an active (recurring) plan?

The answer determines the fix (e.g. compute effective tier at enqueue from credits/plan
validity rather than a sticky `users.tier`).

---

### Issue 10 — `jobs.priority` boolean is lossy

**Severity:** Low · **Area:** Scheduling · **Files:**
`apps/api/src/modules/jobs/create.ts`, `apps/api/src/modules/admin/jobs.routes.ts`

**What's wrong**
A 2-state boolean can't represent 3 tiers. `create.ts:218` sets `priority` true only for
the `priority` stream, so `normal` and `low` both store `false`. Admin retry then routes
off that boolean:

```ts
const stream = job.priority ? 'jobs:priority' : 'jobs:normal'; // admin/jobs.routes.ts:247
```

So **retrying a `low`-tier job silently promotes it to `normal`**, and a job's tier can
never round-trip through a retry.

**Recommended fix**
Persist the actual tier/stream name on the job row and derive any boolean from it; use it
for retry routing.

---

### Issue 11 — `jobs:low` queue depth is never measured

**Severity:** Low · **Area:** Observability · **File:**
`apps/dispatcher/src/worker/health-monitor.ts`

**What's wrong**
The queue-depth gauge samples only two of the three streams:

```ts
const JOB_STREAMS = ['jobs:priority', 'jobs:normal'] as const; // 'jobs:low' missing
```

**Impact**
A starving `jobs:low` queue (the exact symptom of Issue 8) is **invisible** on
dashboards.

**Recommended fix**
Add `jobs:low` to the sampled streams.

---

## 5. Queue, recovery & cancellation issues

### Issue 1 — Redis stream unbounded growth

**Severity:** High · **Area:** Infra · **Files:**
`apps/api/src/modules/jobs/create.ts`, `apps/dispatcher/src/job/processor.ts`

**What's wrong**
Every enqueue uses an untrimmed `XADD`:

```ts
await app.redis.xadd(stream, '*', 'jobId', jobId, 'userId', userId); // create.ts:249
```

`XACK` removes an entry from the consumer group's PEL, **not from the stream itself.**
Stream entries are retained indefinitely, so `jobs:priority|normal|low` grow without
bound and consume Redis memory forever.

**Impact**
Slow-burn production outage: Redis memory climbs until eviction/OOM, which can take down
the whole queue.

**Recommended fix**
Use a capped, approximate trim on every `XADD`:
`XADD <stream> MAXLEN '~' <N> '*' ...` (e.g. N = 10,000). This bounds retained history,
not live queue depth. Apply in both `create.ts` and the dispatcher requeue paths.

---

### Issue 2 — Adding a GPU is unreliable

**Severity:** High (ops) · **Area:** Ops · **Files:**
`apps/dispatcher/src/index.ts`, `scripts/register-workers.ts`

**What's wrong — two parts**

1. **Concurrency is frozen at boot.** The consumer's in-flight cap is computed once from
   `WORKER_IDS` at startup:
   ```ts
   const stopConsumer = await runConsumer(redis, processorCfg, log, workers.length); // index.ts:101
   ```
   Registering a new worker in Redis while the dispatcher runs does **not** raise the
   cap — the new GPU sits idle until the dispatcher is restarted. (A restart is safe:
   `recoverPendingJobs` reclaims in-flight messages — modulo Issue 13.)

2. **`scripts/register-workers.ts` is stale.** It writes registry entries **without** an
   `apiKey`, but the selector/processor now require per-worker API keys (added in commit
   `e9e2617`). The "documented" manual-add path therefore yields **auth failures** when
   the dispatcher calls that worker's ComfyUI.

**Impact**
Tomorrow's 3rd GPU (and every future one) can't be brought online reliably via the
documented path.

**Recommended fix**
- Update `register-workers.ts` to include `WORKER_<ID>_API_KEY` (mirror `registerWorkers`
  in `index.ts`).
- Document a short "add a GPU" runbook: set `WORKER_IDS` + `WORKER_<ID>_URL` +
  `WORKER_<ID>_API_KEY`, then restart the dispatcher.
- *(Optional)* derive consumer concurrency from the live registry size so no restart is
  needed. Only if low-effort; restart is acceptable for the current cadence.

---

### Issue 15 — No-worker requeue loops forever and loses position

**Severity:** Medium · **Area:** Recovery · **File:**
`apps/dispatcher/src/job/processor.ts`

**What's wrong**
When no idle/healthy worker is available, the job is re-enqueued with a backoff:

```ts
if (!worker) {
  await db.update(schema.jobs).set({ status: 'QUEUED' }).where(eq(schema.jobs.id, jobId));
  await new Promise((r) => setTimeout(r, 10_000));
  await redis.xadd(stream, '*', 'jobId', jobId, 'userId', userId); // back of stream
  await redis.xack(stream, 'dispatcher-cg', messageId);
  return; // ← attempts NOT incremented
}
```

If **all GPUs are down** (outage, tunnel failure, all health keys expired), every queued
job spins in this 10s re-enqueue loop **indefinitely** — never terminal, never refunded,
credits held — and **loses its FIFO position** on each loop.

**Impact**
A sustained GPU/tunnel outage produces a pile of permanently-stuck jobs with locked-up
credits and scrambled ordering, with no automatic resolution.

**Recommended fix**
Add a max-wait / dead-letter policy: track time-in-queue (or a bounded re-enqueue count)
and, past a threshold, fail+refund the job with a clear error code. Preserve ordering
(re-enqueue at the front, or use a separate "waiting for capacity" handling that doesn't
reshuffle).

---

### Issue 16 — No cancel path for queued or active jobs

**Severity:** Medium · **Area:** UX / cost · **Files:**
`apps/api/src/modules/jobs/routes.ts`, `apps/dispatcher/src/job/state.ts`

**What's wrong**
The only mutation endpoint is `DELETE /v1/jobs/:id`, which **refuses** non-terminal jobs:

```ts
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
if (!TERMINAL.includes(job.status)) {
  throw new AppError('CONFLICT', 409, 'cannot delete an active job'); // routes.ts:260
}
```

There is **no cancel endpoint.** `CANCELLED` is referenced in the TERMINAL list and in
the web client, but **nothing ever produces it** — it isn't even part of the `JobStatus`
type:

```ts
export type JobStatus =
  | 'QUEUED' | 'PREPROCESSING' | 'GENERATING' | 'UPLOADING' | 'COMPLETED' | 'FAILED';
  // no CANCELLED — state.ts:6
```

**Impact**
During a long backlog, a user who made a mistake (wrong garment, wrong poses) **cannot
cancel or get a refund**, and the unwanted jobs still consume GPU slots — deepening the
queue for everyone.

**Recommended fix**
Add a cancel endpoint for `QUEUED` (and ideally not-yet-dispatched) jobs that sets
`CANCELLED`, refunds credits, and removes the stream entry. Add `CANCELLED` to the
`JobStatus` type and handle it in the dispatcher (skip if a reclaimed job is already
`CANCELLED`).

---

### Issue 3 — Stale-job reclaim only runs at boot

**Severity:** Medium · **Area:** Recovery · **Files:**
`apps/dispatcher/src/index.ts`, `apps/dispatcher/src/stream/recovery.ts`

**What's wrong**
`recoverPendingJobs` runs **once, at startup** (`index.ts:97`). The in-process 300s
completion timeout covers a job whose worker dies while the dispatcher stays alive, but a
message orphaned in the PEL by other means waits until the next restart to be reclaimed.

**Recommended fix**
Run a lightweight periodic reclaim (`XAUTOCLAIM`, or `recoverPendingJobs` on an interval,
e.g. every 60s) alongside the health monitor. Combine with Issues 13 & 14 so reclaimed
jobs converge to a correct state.

---

### Issue 4 — SSE Redis connection fan-out under backlog

**Severity:** Medium · **Area:** Scale · **File:**
`apps/api/src/modules/jobs/sse.ts`

**What's wrong**
Each SSE connection opens its **own** Redis subscriber connection:

```ts
const sub: Redis = (req.server as any).redisSub.duplicate(); // sse.ts:28 — per connection
```

During a 90-min drain, ~100 user tabs hold open SSE connections → **100+ extra Redis
client connections** (plus file descriptors), one per tab.

**Impact**
Risk of hitting Redis `maxclients` / OS fd limits at exactly the moment the system is
busiest, which would break live progress for everyone.

**Recommended fix**
Share a **single** Redis subscriber across SSE connections with an in-process fan-out
keyed by `userId` (refcount subscriptions; unsubscribe when the last subscriber for a
user disconnects). The 15s heartbeat (`sse.ts:48`) and reconnect logic stay as-is.

**Open question:** what is the prod Redis `maxclients` and expected peak concurrent open
tabs? That sets the ceiling we design against.

---

### Issue 5 — Input retention must exceed max queue wait

**Severity:** Medium · **Area:** Infra · **File:**
`apps/dispatcher/src/job/processor.ts` (input download via `r2Download`)

**What's wrong**
A delayed job downloads its garment from R2 up to ~90 min after upload. If an R2/MinIO
lifecycle rule deletes user uploads sooner, the delayed job fails at download time.

**Recommended fix**
Verify the upload-key prefix lifecycle guarantees retention safely above the max queue
wait (e.g. ≥ 24h) and document it. No code change if lifecycle is already safe.

**Open question:** what is the current R2/MinIO lifecycle config for upload keys?

---

### Issue 17 — No idempotency key on job submission

**Severity:** Low–Medium · **Area:** Credits · **File:**
`apps/api/src/modules/jobs/routes.ts`

**What's wrong**
`POST /v1/jobs/tryon` (`routes.ts:12`) accepts no idempotency key. A client retry (flaky
network, double-submit that slips past the UI guard) creates **duplicate jobs and
duplicate charges** — the server can't tell a retry from a new request.

**Recommended fix**
Accept an idempotency key (header or body field); dedupe within a short window so a retry
returns the original result instead of creating/charging again.

---

## 6. Lower-priority / future

### Issue 6 — No per-user fairness within a tier

**Severity:** Low · **Area:** Scheduling

Within a single tier the queue is strict FIFO. With everyone submitting 4 poses this is
roughly fair, but one user dumping 50+ jobs starves other users in the same tier.
**Optional:** interleave by distinct `userId` when reading a stream. Defer unless
power-user abuse becomes real (adds scheduler complexity; overlaps with Issue 8).

### Issue 7 — No ComfyUI batching

**Severity:** Low (future) · **Area:** Throughput

Currently 1 ComfyUI prompt per job (4 poses = 4 prompts). Batching a user's poses into a
single run could cut per-job overhead, but is risky (workflow-template changes,
partial-failure handling). Noted as a future throughput optimization; out of scope for
initial hardening.

---

## 6.5 Security & abuse vectors (purchases, credits, job creation)

> Reviewed the trust boundaries a non-admin user can reach by calling the API
> **directly** (bypassing the studio UI). Two findings (S1, S2) are genuine,
> high-impact economic exploits. The upload-key and price-tampering surfaces, by
> contrast, are well defended (see §6.6).

### S1 — Credit cost is client-declared and decoupled from the real output  *(money exploit)*

**Severity:** High (money) · **Area:** Security/Credits · **Files:**
`packages/types/src/jobs.ts`, `apps/api/src/modules/jobs/create.ts`,
`apps/dispatcher/src/workflow/patcher.ts`

**What's wrong**
The price charged is taken from the request's `resolution` field, but the **actual
output dimensions** are driven by *different* client-controlled fields:

```ts
// Cost (create.ts:58) — derived purely from the client's declared resolution
const COST = RESOLUTION_COSTS[resolution];   // HD=25, 2K=35, 4K=40  (jobs.ts:3-7,44)

// Real output size (patcher.ts:145-150) — custom dims WIN over everything
const customDims = inputs.outputWidth && inputs.outputHeight
  ? { width: inputs.outputWidth, height: inputs.outputHeight } : null;
const enumDims = inputs.aspectRatio ? ASPECT_DIMENSIONS[inputs.aspectRatio] : null;
const outputDims = customDims ?? enumDims;
```

`params.outputWidth` / `outputHeight` are accepted up to **4096** (`jobs.ts:38-39`), and
`resolution` and `aspectRatio` are **independent enums** with no enforced relationship.

**Exploit**
Call `POST /v1/jobs/tryon` with `resolution: "HD"` (charged 25 credits) **and**
`params: { outputWidth: 4096, outputHeight: 4096 }`. Result: a 4096×4096 render — larger
than the 4K tier — for the cheapest price. Even without custom dims, a user can always
declare the cheapest `resolution` regardless of the `aspectRatio` they actually render.
**The cost is effectively self-declared by the client.**

**Impact**
Systematic undercharging / free high-resolution output; revenue leakage proportional to
how many users discover it.

**Recommended fix**
Compute cost **server-side from the real output dimensions** (e.g. a
`resolutionFromOutputDims(w, h)` derived from `aspectRatio` + any custom dims), and do not
trust the client's `resolution` for pricing. Reject `outputWidth/outputHeight` that exceed
the dimensions allowed for the user's paid tier.

### S2 — Payment verify/webhook can double-credit  *(money exploit)*

**Severity:** High (money) · **Area:** Security/Payments · **File:**
`apps/api/src/modules/payments/routes.ts`

**What's wrong**
The "already credited?" check is **outside** the transaction, and the status update
**inside** the transaction is **not conditional** on the current status:

```ts
if (payment.status === 'paid') return { ok: true, alreadyCredited: true }; // :210 (outside tx)
await app.db.transaction(async (tx) => {
  await tx.update(schema.payments)
    .set({ status: 'paid', ... })
    .where(eq(schema.payments.razorpayOrderId, razorpayOrderId)); // :214-222 — no `AND status<>'paid'`
  // ...additive credit + ledger insert (no DB uniqueness for PAYMENT credits)
});
```

The webhook handler (`:333-372`) has the same shape. The credit ledger has **no unique
constraint** for payment credits (`packages/db/src/schema/credits.ts` — only
`razorpayOrderId` on the *payments* row is unique, which does not prevent a second
additive credit to `userCredits`).

**Exploit**
Complete **one** real payment, then fire `/v1/payments/verify` several times
**concurrently** (the Razorpay signature is reusable) — or let `/verify` race the webhook.
Each call reads `status !== 'paid'` before any commits, then each grants credits →
**multiplied credits from a single purchase.**

**Impact**
Direct credit inflation / theft of paid value.

**Recommended fix**
Make the transition atomic and idempotent — only credit if *this* call performed the
state change:

```sql
UPDATE payments SET status='paid', ...
 WHERE razorpay_order_id = $1 AND status <> 'paid'
 RETURNING id;   -- credit ONLY if a row was returned (rowCount === 1)
```

Apply identically in the webhook. Optionally add a unique constraint backing the payment
credit (e.g. unique `creditLedger` row per `razorpayPaymentId`).

### S3 — App-level (non-atomic) idempotency on credits/refunds

**Severity:** Medium · **Area:** Security/Credits · **Files:**
`apps/api/src/modules/credits/ledger.ts`, `apps/dispatcher/src/job/processor.ts`

**What's wrong**
All idempotency for refunds is "SELECT then INSERT" in application code
(`ledger.ts:33-37`; fail-refund `processor.ts:761-765`), with **no DB unique constraint**
on `creditLedger(jobId, reason)`. Two concurrent callers (retry + periodic recovery, or
the zombie-recovery path from Issue 13) can both pass the SELECT and both INSERT →
**double refund**.

**Recommended fix**
Add a unique index on `creditLedger(jobId, reason)` and use `INSERT ... ON CONFLICT DO
NOTHING`, so the database — not a race-prone app check — guarantees single application.

### S4 — Client-controlled compute at a flat price

**Severity:** Medium · **Area:** Security/Cost · **File:** `packages/types/src/jobs.ts`

**What's wrong**
`stepsStage1` / `stepsStage2` are accepted up to **60** each (`jobs.ts:36-37`) and custom
dims up to 4096 — both directly increase GPU time — while the credit price is flat per
`resolution`. A user can max these out for far more compute per credit.

**Impact**
Resource abuse: longer GPU occupancy per credit deepens the queue for everyone (amplifies
the backlog this whole document is about) and raises cost-to-serve.

**Recommended fix**
Cap `steps` and dimensions per paid tier (or fold compute into the cost calculation
from S1).

### S5 — Free-trial credits farmable via disposable emails  *(mitigated)*

**Severity:** Low (mitigated) · **Area:** Security/Credits · **Files:**
`apps/api/src/modules/auth/routes.ts`, `apps/api/src/modules/auth/google.routes.ts`

**What's wrong**
Free-trial credits are granted at account creation for both email/password
(`auth/routes.ts:113-129`, reason `FREE_TRIAL`) and Google (`google.routes.ts:150-161`).

**Mitigation already in place**
Spending is gated behind a **verified email** — `requireUser` rejects unverified accounts
(`apps/api/src/plugins/auth.ts:43`) and `/v1/jobs/tryon` uses it. So farming requires a
working inbox per account, which raises the bar.

**Residual risk**
Disposable/temp-mail services still receive verification links, so determined Sybil
farming of free credits remains possible.

**Recommended fix (if free-trial abuse is observed)**
Add throttles such as per-IP / per-device signup limits, block known disposable-email
domains, or require a payment method before granting trial credits.

### S6 — Catalog IDs not validated at job creation

**Severity:** Low · **Area:** Security/Validation · **File:**
`apps/api/src/modules/jobs/create.ts`

**What's wrong**
`create.ts` validates `faceId`, `backgroundId`, and `poseIds` exist and are active, but
**does not** validate `lowerCatalogId`, `shoeCatalogId`, or `garmentTypeId`. Unknown IDs
resolve to null in the dispatcher and fall back to the upper garment
(`patcher.ts:100,118`). Not a credit exploit, but inconsistent validation and a possible
source of silently-wrong output.

**Recommended fix**
Validate these IDs (existence + active + ownership where applicable) at creation, same as
the other catalog inputs.

### S7 — No idempotency key on job submission

**Severity:** Low–Medium · **Area:** Security/Credits · **File:**
`apps/api/src/modules/jobs/routes.ts` — *(same as Issue 17)*

A client retry of `POST /v1/jobs/tryon` creates duplicate jobs **and** duplicate charges.
See Issue 17 for the fix (accept and dedupe on an idempotency key).

---

## 6.6 Trust boundaries that ARE well defended (no action)

For completeness / reassurance — these common attack surfaces were checked and are sound:

- **Upload keys cannot be spoofed.** The key is server-generated
  (`apps/api/src/modules/uploads/routes.ts:19-20`), format-pinned by regex
  (`jobs.ts:17-18`), bound to the issuing user in Redis, and re-checked + size-verified at
  job creation (`create.ts:24-38`).
- **Payment price cannot be tampered.** The order amount is computed server-side from the
  plan (`payments/routes.ts:132-151`); the client never sends a price.
- **Razorpay signatures** are verified with `timingSafeEqual` (`payments/routes.ts:190-198`
  and `:287-292`).
- **No overspend / negative balance.** `atomicDeduct` uses
  `UPDATE ... WHERE balance >= amount RETURNING` (`ledger.ts:7-19`).
- **Payment ownership** is enforced (`payment.userId !== req.userId` → 403,
  `payments/routes.ts:209`).
- **Spending requires a verified email** (`plugins/auth.ts:43`).

---

## 7. Recommended sequencing

**Phase 1 — Pre-prod must-haves (correctness, money, availability):**
- ✅ **S1** server-side cost from real output dims — `resolutionFromDims()` in `@tryme/types`; create.ts derives COST from actual dims
- ✅ **S2** atomic/idempotent payment crediting — conditional `UPDATE WHERE status='created' RETURNING` in verify + webhook
- ✅ **#12** refund on pre-flight failure — `markFailed` routes through `terminateJob` (shared with `handleFailure`)
- ✅ **#13** zombie-job recovery — in-progress statuses on reclaim route through `handleFailure` instead of silent ACK
- ✅ **#14** atomic refund/transition — single DB transaction in `terminateJob` (refund + UPDATE jobs + INSERT jobEvents)
- ✅ **S3** unique index on `creditLedger(job_id, reason)` — migration 0074; all refund paths use `onConflictDoNothing`
- ✅ **#1** Redis stream trimming — all `xadd` calls (create.ts, requeue paths) use `MAXLEN ~ 10000`
- ✅ **#2** register-workers.ts deleted (obsolete — admin panel is source of truth); runbook in CLAUDE.md
- 🔵 **#5** verify input retention — ops action: confirm R2/MinIO lifecycle on `inputs/` prefix ≥ 24h
- 🔵 **#9** tier-expiry rule — product decision required (credits > 0 / N-day window / recurring plan)

**Phase 2 — Reliability & scale under load:**
- ✅ **#3** periodic stale-job reclaim — `setInterval(recoverPendingJobs, 60s)` in dispatcher index
- ✅ **#15** no-worker dead-letter — 3h timestamp check; terminates + refunds instead of looping forever
- ✅ **#16** cancel path — `POST /v1/jobs/:id/cancel`; `CANCELLED` added to `JobStatus`; atomic refund
- ✅ **#11** measure `jobs:low` — added to `JOB_STREAMS` in health-monitor
- 🔵 **#8** anti-starvation scheduling — product decision required (reserved capacity / weighted round-robin / aging)
- 🔵 **#4** shared SSE subscriber — needs prod Redis `maxclients` + expected peak concurrent tabs before design
- ✅ **#17 / S7** idempotency key — `Idempotency-Key` header; 24h Redis cache on all three job endpoints
- ✅ **S4** compute abuse capped — `stepsStage1/2` max halved to 30 in Zod schema; per-tier limit deferred until step pricing decided

**Phase 3 — Cleanup / future:**
- ✅ **#10** lossy `priority` boolean — migration 0075 adds `queue_stream` column; backfill from boolean; admin retry uses it directly
- ✅ **#11** measure `jobs:low` — done ahead of schedule
- ✅ **S6** validate `lowerCatalogId`/`shoeCatalogId`/`garmentTypeId` at creation — done
- 🔴 Deferred: #6 per-user fairness, #7 ComfyUI batching, S5 anti-farming (only if abuse observed)

---

## 8. Decisions needed from product/leadership

1. **Issue 9 — tier expiry rule.** Priority only while credits > 0? For N days after
   purchase? Only on an active recurring plan? Once decided, #9 can be implemented in
   `create.ts` (compute effective tier from live balance instead of sticky `users.tier`)
   and #8 (anti-starvation) can be sized appropriately.
2. **Issue 8 — anti-starvation strategy.** Reserved capacity vs. weighted round-robin
   vs. aging. Depends on #9 decision — if the priority cohort naturally shrinks (credits
   expiry), starvation pressure may be acceptable without structural changes.
3. **Issue 4 — connection ceiling.** Provide prod Redis `maxclients` and expected peak
   concurrent open tabs. Once known, the shared-subscriber refactor can be scoped or
   deferred if the ceiling is comfortably above expected load.
4. **Issue 5 — upload lifecycle.** Ops action (no code): confirm that the R2/MinIO
   lifecycle rule for the `inputs/` key prefix retains objects for ≥ 24 hours. Document
   the confirmed value. No code change if already safe.

---

## 9. How to verify the fixes (acceptance tests)

1. **Pre-flight refund (#12):** create a job, deactivate its pose before dispatch,
   confirm the job ends `FAILED` **and** credits are refunded (ledger has
   `JOB_FAIL_REFUND`, balance restored).
2. **Crash recovery (#13/#14):** kill the dispatcher mid-job; on restart confirm the job
   reaches a correct terminal state (completed, or failed+refunded) — never stuck in
   `PREPROCESSING`, never double-charged/double-refunded.
3. **Backlog soak:** seed ~400 `jobs:normal` entries against the 3-worker setup (or a
   mock ComfyUI). Confirm all reach a terminal state, none fail on timeout, credits
   balance, and the last job is fetchable via `/v1/jobs/:id/result`.
4. **Starvation (#8):** with priority jobs continuously arriving, confirm normal/low jobs
   still make progress within the chosen policy.
5. **Stream trim (#1):** after the soak, `XLEN jobs:*` stays bounded near MAXLEN.
6. **Add-a-GPU (#2):** run the updated `register-workers.ts` for a 3rd worker, restart
   the dispatcher, confirm `workersHealthy=3` and round-robin hits all three workers.
7. **No-worker dead-letter (#15):** take all workers offline; confirm jobs eventually
   fail+refund (or move to a waiting state) rather than looping forever.
8. **Cancel (#16):** cancel a `QUEUED` job; confirm `CANCELLED` + refund + the stream
   entry is gone and the dispatcher never processes it.
9. **SSE scale (#4):** open many concurrent `/v1/jobs/stream` connections; confirm the
   Redis client count stays flat (single shared subscriber) and heartbeats flow.
10. **Idempotency (#17):** submit the same request twice with the same key; confirm one
    job and one charge.
11. **Result durability:** submit, close the tab, reopen `/catalogues/:id` after
    completion — results render from the DB without SSE.
12. **Cost integrity (S1):** submit with `resolution:"HD"` + `params.outputWidth/Height`
    larger than the HD tier; confirm the request is rejected or charged at the true
    (higher) rate — never HD price for a larger render.
13. **Payment idempotency (S2):** fire `/v1/payments/verify` N times concurrently for one
    paid order, and replay the webhook; confirm credits are granted **exactly once**.
14. **Refund idempotency (S3):** force concurrent fail-refund + recovery on one job;
    confirm exactly one `JOB_FAIL_REFUND` ledger row (DB unique constraint holds).
15. **Compute caps (S4):** submit `stepsStage1/2 = 60` and oversized dims; confirm they're
    rejected or priced per the user's tier.
