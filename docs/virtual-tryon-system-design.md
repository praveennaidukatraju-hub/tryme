# Virtual Try-On Platform — System Design v3 (as built)

**Project:** AI-Powered Virtual Try-On SaaS
**Stack:** Next.js 15 (web) · Vite + React SPA (admin) · Node.js/TypeScript · Fastify 5 · PostgreSQL 16 (Drizzle) · Redis 7 Streams · S3-compatible storage (Cloudflare R2 prod / MinIO local) · Cloudflare Tunnels · ComfyUI on GPU VPS
**Target Scale:** 100 subscribers at launch (v1), N VPS GPU workers (`WORKER_IDS`)

> **v3 reflects the implemented system.** Sections 1–11 describe what is actually built and running.
> The original v2 spec (RunPod→Hostinger migration, generic catalog model) is superseded; key drifts
> are summarized in the change log below.

---

## Change Log: v2 spec → v3 (as built)

| Area                | v2 spec                                               | v3 (built)                                                                                           |
| ------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Asset model         | One generic `catalog_items` table for all input types | Dedicated tables: `model_faces`, `model_backgrounds`, `model_poses`, `garment_subcategories`         |
| Pose model          | Pose = a `catalog_items` row                          | Pose = (garment subcategory × face × background) combo, bound to a `workflow_templates` row          |
| Lower/shoe          | `lowerCatalogId` (catalog item)                       | `catalog_items` with `type` (`lower`\|`shoe`) + `genderSlug`; linked to subcategories via join table |
| Workflows           | Single static template in `templates/`                | `workflow_templates` table (DB-stored JSON + node-ID mappings); admin upload + auto node detection   |
| Job inputs          | garment + model + pose + background + lower (single)  | garment + faceId + backgroundId + **poseIds[] (1–6)** + optional lower/shoe + `aspectRatio`          |
| Catalogue grouping  | Not present                                           | One job per pose under a shared `catalogue_id`; `/v1/catalogues` groups them                         |
| Admin panel         | Next.js routes inside `apps/catalogues-web`                      | Standalone Vite + React SPA (`apps/admin-web`) hitting `/admin/*`                                        |
| Auth                | Email/password + JWT                                  | + Google OAuth, email verification + password reset (Resend), 1h idle timeout, silent refresh        |
| Worker routing      | Cloudflare LB hostname (or Redis fallback)            | Dispatcher reads per-worker `WORKER_<ID>_URL`, selects healthy IDLE worker from Redis registry       |
| Worker progress     | ComfyUI WebSocket                                     | ComfyUI `/history/{promptId}` polling (every 3s)                                                     |
| Storage (local dev) | —                                                     | MinIO via the same `StorageProvider` interface                                                       |

---

## 1. Architecture Overview

### 1.1 High-Level Diagram

```
Internet Traffic
      │
      ▼
┌─────────────────────────────────────┐
│         Cloudflare (Free/Pro)       │
│  DDoS · WAF · Rate Limit · SSL/CDN  │
│  Tunnel Ingress Controller          │
└──────────────┬──────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│                    Main VPS (CloudPanel)                      │
│                                                              │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐    │
│  │  Next.js 15  │ │ Admin SPA    │ │  Fastify API (TS)  │    │
│  │  apps/catalogues-web    │ │ apps/admin-web   │ │                    │    │
│  │  (port 3000) │ │ (Vite/React) │ │  /v1/auth  JWT+OAuth│   │
│  │              │ │              │ │  /v1/jobs  CRUD+SSE │   │
│  │ Studio wizard│ │ assets,poses │ │  /v1/catalogues     │   │
│  │ Catalogues   │ │ workflows,   │ │  /v1/uploads presign│   │
│  │ Pricing      │ │ users,credits│ │  /v1/catalog        │   │
│  │ Settings     │ │ jobs,results │ │  /v1/models         │   │
│  └──────┬───────┘ └──────┬───────┘ │  /admin/*  full CRUD│   │
│         │ SSE/REST       │ REST     │  /results  monitor  │   │
│         └────────────────┴─────────▶└─────────┬──────────┘    │
│                                               │               │
│  ┌──────────────────┐  ┌─────────────────────▼──────────┐    │
│  │   PostgreSQL     │  │            Redis               │    │
│  │   (127.0.0.1)    │  │         (127.0.0.1)            │    │
│  │                  │  │                                │    │
│  │  users           │  │  Stream: jobs:priority         │    │
│  │  oauth_accounts  │  │  Stream: jobs:normal           │    │
│  │  refresh_tokens  │  │  Group:  dispatcher-cg         │    │
│  │  user_credits    │  │  Hash:   worker:registry       │    │
│  │  credit_ledger   │  │  Key:    worker:health:{id}    │    │
│  │  credit_requests │  │  Pub/Sub: job SSE events       │    │
│  │  jobs            │  └────────────────────────────────┘    │
│  │  job_inputs      │                                        │
│  │  job_events      │  ┌────────────────────────────────┐    │
│  │  job_outputs     │  │   Dispatcher Service (TS)      │    │
│  │  model_faces     │  │                                │    │
│  │  model_backgrounds│ │  Redis Stream consumer         │    │
│  │  model_poses     │  │  Worker health monitor (15s)   │    │
│  │  garment_subcats │  │  Workflow clone + patch        │    │
│  │  workflow_templates│ │  /history polling (3s)        │    │
│  │  catalog_items   │  │  Retry (max 2) + refund        │    │
│  │  catalog_item_subcats│ SSE event publisher          │    │
│  │  admin_users     │  └───────────────┬────────────────┘    │
│  └──────────────────┘                  │                     │
└─────────────────────────────────────────┼────────────────────┘
                                         │
                          Cloudflare Tunnel (named: tryon-workers)
                          Single logical hostname: workers.internal
                                         │
                   ┌─────────────────────┴──────────────────────┐
                   │          Cloudflare Load Balancer           │
                   │   Health-check aware · weighted routing     │
                   └──────────┬──────────────────┬──────────────┘
                              │                  │
              ┌───────────────▼──┐          ┌────▼─────────────────┐
              │  Hostinger VPS A │          │  Hostinger VPS B     │
              │  1× A100 80GB    │          │  1× A100 80GB        │
              │                  │          │                      │
              │  cloudflared     │          │  cloudflared         │
              │  ComfyUI :8188   │          │  ComfyUI :8188       │
              │  tunnel-id: A    │          │  tunnel-id: B        │
              └──────────────────┘          └──────────────────────┘

                        ┌──────────────────────────────┐
                        │   R2 (prod) / MinIO (local)   │
                        │                              │
                        │  bucket/                      │
                        │    uploads/{userId}/…  ← user │
                        │    outputs/{jobId}/result.png │
                        │    faces/{id}.jpg             │
                        │    backgrounds/{id}.jpg       │
                        │    poses/{id}.jpg             │
                        │    catalog/{id}.jpg (lower/shoe)│
                        │  (R2 key builders in          │
                        │   packages/storage)           │
                        └──────────────────────────────┘
```

---

## 2. Cloudflare Tunnel Architecture

This replaces the RunPod public proxy approach. No ports are exposed on Hostinger VPS machines.

### 2.1 How It Works

```
Dispatcher (on main VPS)
    │  POST https://workers.tryon.internal/prompt
    │
    ▼
Cloudflare Network (Argo Tunnel)
    │  Matches tunnel route
    │  Performs health check
    │
    ▼
cloudflared daemon (on ComfyUI VPS A or B)
    │  Forwards to localhost:8188
    │
    ▼
ComfyUI /prompt endpoint
```

### 2.2 Tunnel Setup Per Worker VPS

Each ComfyUI VPS runs a `cloudflared` daemon:

```bash
# On each ComfyUI VPS — run once to create tunnel
cloudflared tunnel create tryon-worker-a      # produces tunnel-id-a
cloudflared tunnel create tryon-worker-b      # produces tunnel-id-b

# Route each tunnel to a hostname
cloudflared tunnel route dns tryon-worker-a  worker-a.tryon.yourdomain.com
cloudflared tunnel route dns tryon-worker-b  worker-b.tryon.yourdomain.com
```

**Config file on VPS A** (`~/.cloudflared/config.yml`):

```yaml
tunnel: tryon-worker-a
credentials-file: /root/.cloudflared/<tunnel-id-a>.json
ingress:
  - hostname: worker-a.tryon.yourdomain.com
    service: http://localhost:8188
  - service: http_status:404
```

### 2.3 Load Balancer (Cloudflare — requires Pro or $5 LB add-on)

```
Hostname: workers.tryon.yourdomain.com
  └── Pool: comfyui-workers
        ├── Origin: worker-a.tryon.yourdomain.com  weight=1
        └── Origin: worker-b.tryon.yourdomain.com  weight=1

Health Check:
  Path: /system_stats
  Expected: HTTP 200
  Interval: 15s
  Unhealthy threshold: 2 failures
  Healthy threshold: 1 success
```

> **If you want to avoid the LB cost ($5/mo):** The dispatcher can maintain its own worker registry in Redis with per-worker URLs (`worker-a.tryon.yourdomain.com`, `worker-b...`) and do health-check-aware routing itself. This is the fallback described in Section 4.3.

### 2.4 Security

```
Cloudflare Access Policy (Zero Trust — free tier):
  Application: workers.tryon.yourdomain.com/*
  Policy: Service Token only
    → Dispatcher sends CF-Access-Client-Id + CF-Access-Client-Secret headers
    → Direct browser access blocked
    → ComfyUI UI never publicly reachable
```

---

## 3. Input Model — Curated Assets + User Upload

The generic "everything is a catalog item" model from the v2 spec was replaced. Faces, backgrounds,
and poses are now first-class admin-curated asset tables; only lower garments and shoes remain in
`catalog_items`. A **pose** is the central object: it is a specific (garment subcategory × face ×
background) combination and is bound to a **workflow template**.

### 3.1 What the User Provides

| Input         | Source        | Notes                                                                        |
| ------------- | ------------- | ---------------------------------------------------------------------------- |
| Upper Garment | User upload   | Direct-to-storage presigned URL (`POST /v1/uploads/presign` → PUT → use key) |
| Garment Type  | Selection     | A `garment_subcategories` row (e.g. men → full-sleeve shirt) — drives poses  |
| Face (Model)  | Curated       | `model_faces`, filtered by gender                                            |
| Background    | Curated       | `model_backgrounds` (global pool, optional gender filter)                    |
| Pose(s)       | Curated       | `model_poses` for the chosen subcategory×face×background — **1–6 selected**  |
| Lower Garment | Catalog (opt) | `catalog_items` `type='lower'`, shown only when a selected pose `showsLower` |
| Shoes         | Catalog (opt) | `catalog_items` `type='shoe'`, shown only when a selected pose `showsShoes`  |
| Aspect Ratio  | Selection     | one of `1:1 · 3:4 · 4:5 · 3:2 · 9:16 · 16:9`                                 |

Each pose references a `workflow_templates` row. The workflow declares which ComfyUI nodes receive
face/pose/background/upper/lower/shoe images and which control output size. A pose can only enable
lower/shoe if its workflow actually has the corresponding `lower_node_id` / `shoe_node_id`.

### 3.2 Asset / Catalog Model

```
garment_subcategories   e.g. { genderSlug: 'men', slug: 'fullsleeveshirt', label: 'Full Sleeve Shirt' }
        │ (1)
        │ poses belong to exactly one subcategory
        ▼
model_poses  ── faceId ──▶ model_faces        (gender-tagged)
   │         ── backgroundId ──▶ model_backgrounds  (global pool, nullable genderSlug)
   │         ── workflowTemplateId ──▶ workflow_templates
   │         showsLower / showsShoes (per-pose toggles)
   │
   └── lower/shoe items resolved via:
        catalog_items (type='lower'|'shoe', genderSlug)
              │
        catalog_item_subcategories  (item ↔ subcategory join)
```

Lower/shoe items declare which garment subcategories they apply to (via
`catalog_item_subcategories`). At job time, for poses with `showsLower`/`showsShoes` enabled, the
API resolves the relevant subcategories → linked active catalog items.

### 3.3 Asset / Catalog DB Schema (actual)

```sql
-- Curated faces (gender-tagged)
CREATE TABLE model_faces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gender TEXT NOT NULL,                 -- 'men' | 'women' | 'boys' | 'girls'
  label TEXT NOT NULL, r2_key TEXT NOT NULL, thumbnail_key TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Global background pool
CREATE TABLE model_backgrounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL, r2_key TEXT NOT NULL, thumbnail_key TEXT NOT NULL,
  gender_slug TEXT,                     -- nullable = shown for all genders
  is_active BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Garment subcategories (the "garment type")
CREATE TABLE garment_subcategories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gender_slug TEXT NOT NULL, slug TEXT NOT NULL, label TEXT NOT NULL,
  thumbnail_key TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ComfyUI workflow templates (DB-stored JSON + node-ID mappings)
CREATE TABLE workflow_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL, label TEXT NOT NULL,
  json_content JSONB NOT NULL,
  face_node_id TEXT NOT NULL, pose_node_id TEXT NOT NULL, bg_node_id TEXT NOT NULL,
  upper_node_ids TEXT[] NOT NULL,
  lower_node_id TEXT,                   -- nullable — workflow has no lower garment
  shoe_node_id TEXT,                    -- nullable — workflow has no shoe garment
  size_node_id TEXT, size_node_ids TEXT[] NOT NULL DEFAULT '{}',
  face_phase_prompt_node TEXT NOT NULL, garment_phase_prompt_node TEXT NOT NULL,
  default_face_phase_prompt TEXT NOT NULL DEFAULT '',
  default_garment_phase_prompt TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A pose = subcategory × face × background, bound to a workflow
CREATE TABLE model_poses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subcategory_id UUID NOT NULL REFERENCES garment_subcategories(id),
  face_id UUID NOT NULL REFERENCES model_faces(id),
  background_id UUID NOT NULL REFERENCES model_backgrounds(id),
  label TEXT NOT NULL, r2_key TEXT NOT NULL, thumbnail_key TEXT NOT NULL,
  shows_lower BOOLEAN NOT NULL DEFAULT FALSE,
  shows_shoes BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 0,
  workflow_template_id UUID NOT NULL REFERENCES workflow_templates(id),
  prompt_face_phase TEXT, prompt_garment_phase TEXT,
  face_side_r2_key TEXT, bg_comfy_r2_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Catalog types/categories still exist (lower/shoe grouping)
CREATE TABLE catalog_types (id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, label TEXT NOT NULL);
CREATE TABLE catalog_categories (
  id SERIAL PRIMARY KEY, type_id INTEGER NOT NULL REFERENCES catalog_types(id),
  parent_id INTEGER, slug TEXT NOT NULL, label TEXT NOT NULL,
  gender_slug TEXT, sort_order INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Lower/shoe items: type + gender stored directly (category_id now optional)
CREATE TABLE catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id INTEGER REFERENCES catalog_categories(id),
  type TEXT NOT NULL,                   -- 'lower' | 'shoe'
  gender_slug TEXT,                     -- nullable = all genders
  label TEXT NOT NULL, r2_key TEXT NOT NULL, thumbnail_key TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Which subcategories a lower/shoe item targets
CREATE TABLE catalog_item_subcategories (
  catalog_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  subcategory_id  UUID NOT NULL REFERENCES garment_subcategories(id) ON DELETE CASCADE,
  PRIMARY KEY (catalog_item_id, subcategory_id)
);
```

### 3.4 Job Request Shape (actual)

```typescript
const CreateTryOnJobRequest = z.object({
  inputs: z.object({
    upperGarmentKey: z.string().min(1).max(512), // storage key, user-uploaded
    faceId: z.string().uuid(),
    backgroundId: z.string().uuid(),
    poseIds: z.array(z.string().uuid()).min(1).max(6), // multi-pose
    lowerCatalogId: z.string().uuid().optional(),
    shoeCatalogId: z.string().uuid().optional(),
  }),
  params: z
    .object({
      seedStage1,
      seedStage2: z.number().int().optional(),
      stepsStage1,
      stepsStage2: z.number().int().min(1).max(60).optional(),
      outputWidth,
      outputHeight: z.number().int().min(512).max(4096).optional(),
    })
    .optional(),
  userHint: z.string().max(300).optional(), // sanitized before reaching prompt
  aspectRatio: z.enum(['1:1', '3:4', '4:5', '3:2', '9:16', '16:9']),
});
```

The API validates the face/background/pose IDs (and any lower/shoe IDs) exist and are active before
deducting credits. It creates **one job per `poseId`** under a shared `catalogue_id`; credits are
charged per job in one transaction with the job insert. Partial enqueue failure refunds and fails
only the affected jobs.

---

## 4. Dispatcher — Worker Routing

### 4.1 Worker Registry (Redis)

Workers come from `WORKER_IDS` (comma-separated). Each worker's base URL is read from
`WORKER_<ID>_URL` env (e.g. `WORKER_A_URL`). The dispatcher registers them in Redis:

```
Redis Hash: worker:registry
  worker-a → { url: "<WORKER_A_URL>", status: "IDLE", lastSeen: <ts> }
  worker-b → { url: "<WORKER_B_URL>", status: "IDLE", lastSeen: <ts> }

Redis Key: worker:health:worker-a  → "OK"  (TTL: 30s, refreshed by health probe)
Redis Key: worker:health:worker-b  → "OK"  (TTL: 30s, refreshed by health probe)
```

> URLs point at each VPS's `cloudflared` hostname in prod (no inbound ports). In current dev the
> dispatcher talks to worker URLs directly; undici TLS verification is relaxed for self-signed/IP
> endpoints (`NODE_TLS_REJECT_UNAUTHORIZED=0`) — replace with a proper cert in prod.

### 4.2 Health Monitor

Dispatcher runs a background probe every 15s per worker:

```typescript
async function probeWorker(workerId: string, url: string) {
  try {
    const res = await fetch(`${url}/system_stats`, {
      headers: {
        'CF-Access-Client-Id': CF_CLIENT_ID,
        'CF-Access-Client-Secret': CF_CLIENT_SECRET,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      await redis.set(`worker:health:${workerId}`, 'OK', 'EX', 30);
    } else {
      await redis.del(`worker:health:${workerId}`);
    }
  } catch {
    await redis.del(`worker:health:${workerId}`);
  }
}
```

### 4.3 Worker Selection (No Cloudflare LB Required)

```typescript
async function selectWorker(): Promise<Worker | null> {
  const workers = await redis.hgetall('worker:registry');

  for (const [id, raw] of Object.entries(workers)) {
    const w = JSON.parse(raw);
    if (w.status !== 'IDLE') continue;

    const healthy = await redis.get(`worker:health:${id}`);
    if (!healthy) continue;

    // Atomically claim worker
    const claimed = await redis.hset(
      'worker:registry',
      id,
      JSON.stringify({ ...w, status: 'BUSY' }),
    );
    if (claimed) return { id, ...w };
  }
  return null; // all workers busy or unhealthy → job stays in stream
}
```

This means even without the Cloudflare LB, the dispatcher handles routing safely. If VPS A goes down, its health key expires, and all jobs route to VPS B automatically.

### 4.4 Revised Request Lifecycle

```
1. User picks gender → garment type (subcategory) → uploads garment (presigned PUT)
   User selects face, background, 1–6 poses, optional lower/shoe, aspect ratio
        │
        ▼
2. Frontend POST /v1/jobs/tryon
   { inputs:{ upperGarmentKey, faceId, backgroundId, poseIds[], lowerCatalogId?, shoeCatalogId? },
     aspectRatio, userHint? }
        │
        ▼
3. API validates face/background/pose IDs (+ lower/shoe) active & exist
   For each poseId: atomic credit deduct + job insert (one txn) → 402 if insufficient
   Resolves all input IDs → storage keys; writes job_inputs
   Pushes each job to Redis Stream (priority/normal); shares one catalogue_id
   Returns { catalogueId, jobIds }
        │
        ▼
4. Frontend opens SSE per job → GET /v1/jobs/{jobId}/events
        │
        ▼
5. Dispatcher: XREADGROUP (group dispatcher-cg)
   selectWorker() → healthy IDLE worker; mark BUSY
   Resolves keys; clone + patch workflow_templates JSON
   (face/pose/bg/upper/lower/shoe nodes + size nodes from aspectRatio)
   POST {workerUrl}/prompt
        │
        ▼
6. Poll {workerUrl}/history/{promptId} every 3s until outputs appear (or timeout)
   Publishes SSE progress events
        │
        ▼
7. On completion → fetch output image → upload to outputs/{jobId}/result.png
   Update Postgres → COMPLETED; mark worker IDLE; XACK
   On terminal failure (max 2 attempts): refund credits in same txn → FAILED
   Push SSE complete/failed event
```

---

## 5. Admin Panel

The admin panel is a **standalone Vite + React SPA** (`apps/admin-web`), separate from `apps/catalogues-web`. It
talks directly to the API's `/admin/*` routes. (The v2 spec embedded admin in Next.js — superseded.)
A separate read-only **results monitor** is served by the API itself at `/results` (self-contained
HTML, its own cookie auth) for visually inspecting ComfyUI outputs across users.

### 5.1 Access Control

```sql
CREATE TYPE admin_role AS ENUM ('SUPER_ADMIN', 'MODERATOR', 'SUPPORT');

CREATE TABLE admin_users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id),   -- links to main users table
  role       admin_role NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Admin JWT contains `{ sub: userId, role: 'ADMIN', adminRole: 'SUPER_ADMIN' }`.  
All `/admin/*` routes verify `adminRole` via middleware before any handler runs.

### 5.2 Admin API Surface

#### User & Account Management

| Method   | Endpoint           | Description                                                      |
| -------- | ------------------ | ---------------------------------------------------------------- |
| `GET`    | `/admin/users`     | Paginated user list with filters (active, banned, tier)          |
| `GET`    | `/admin/users/:id` | Full user profile + credit balance + job history                 |
| `PATCH`  | `/admin/users/:id` | Update tier, ban/unban, force-logout (invalidate refresh tokens) |
| `DELETE` | `/admin/users/:id` | Soft-delete user account                                         |

#### Credit System

| Method  | Endpoint                              | Description                                           |
| ------- | ------------------------------------- | ----------------------------------------------------- |
| `POST`  | `/admin/credits/grant`                | Grant credits to one user with reason note            |
| `POST`  | `/admin/credits/bulk-grant`           | Grant credits to all users of a tier                  |
| `POST`  | `/admin/credits/deduct`               | Manual deduct (abuse case)                            |
| `GET`   | `/admin/credits/ledger/:userId`       | Full credit ledger for a user                         |
| `GET`   | `/admin/credits/stats`                | Total credits issued/consumed system-wide             |
| `GET`   | `/admin/credits/requests`             | List user credit requests (pending/approved/rejected) |
| `PATCH` | `/admin/credits/requests/:id/approve` | Approve request (editable amount + note)              |
| `PATCH` | `/admin/credits/requests/:id/reject`  | Reject request with note                              |

#### Assets — Faces / Backgrounds / Poses (`/admin/assets/*`)

| Method         | Endpoint                           | Description                                             |
| -------------- | ---------------------------------- | ------------------------------------------------------- |
| `GET/POST/...` | `/admin/assets/faces`              | CRUD curated faces (presign → confirm, toggle, replace) |
| `GET/POST/...` | `/admin/assets/backgrounds`        | CRUD background pool (gender-tagged)                    |
| `GET`          | `/admin/assets/poses`              | List poses; filter by face/background/subcategory       |
| `POST`         | `/admin/assets/poses/confirm`      | Create pose (face, bg, subcategory, workflow, toggles)  |
| `PATCH`        | `/admin/assets/poses/:id`          | Edit pose: label, face/bg, workflow, lower/shoe toggles |
| `POST`         | `/admin/assets/poses/:id/reupload` | Replace pose / bgComfy image                            |

#### Garment Types & Workflows

| Method         | Endpoint                      | Description                                              |
| -------------- | ----------------------------- | -------------------------------------------------------- |
| `GET/POST/...` | `/admin/assets/garment-types` | CRUD `garment_subcategories` (per gender)                |
| `GET`          | `/admin/workflows`            | List workflow templates                                  |
| `POST`         | `/admin/workflows`            | Upload ComfyUI JSON → auto-detect node IDs, enforce size |
| `PATCH`        | `/admin/workflows/:id`        | Edit label/slug, node mappings, prompts                  |

#### Catalog — Lower / Shoe Items (`/admin/catalog/*`)

| Method   | Endpoint                   | Description                                                    |
| -------- | -------------------------- | -------------------------------------------------------------- |
| `GET`    | `/admin/catalog`           | List lower/shoe items (returns `subcategoryIds[]` per item)    |
| `POST`   | `/admin/catalog/items`     | Upload item (presign → confirm); set type/gender/subcategories |
| `PATCH`  | `/admin/catalog/items/:id` | Update label/gender/active/subcategory links; replace image    |
| `DELETE` | `/admin/catalog/items/:id` | Delete item + storage object                                   |

#### Job Oversight

| Method | Endpoint                   | Description                                           |
| ------ | -------------------------- | ----------------------------------------------------- |
| `GET`  | `/admin/jobs`              | All jobs across all users, paginated + filterable     |
| `GET`  | `/admin/jobs/:id`          | Full job detail including worker used, timing         |
| `POST` | `/admin/jobs/:id/retry`    | Force retry a FAILED job                              |
| `POST` | `/admin/jobs/:id/cancel`   | Force cancel a stuck job + refund credits             |
| `GET`  | `/admin/workers`           | Live worker registry status from Redis                |
| `POST` | `/admin/workers/:id/drain` | Mark worker as draining (no new jobs, finish current) |

#### System Config

| Method  | Endpoint        | Description                                                   |
| ------- | --------------- | ------------------------------------------------------------- |
| `GET`   | `/admin/config` | Current system settings (credit costs, rate limits)           |
| `PATCH` | `/admin/config` | Update settings (credit cost per job, max jobs/day)           |
| `GET`   | `/admin/stats`  | Dashboard summary: jobs today, credits consumed, active users |

### 5.3 R2 Catalog Upload Flow (Admin)

```
Admin selects image file(s) in admin panel
    │
    ▼
POST /admin/catalog/items/presign  → returns { uploadUrl, r2Key, thumbnailUploadUrl, thumbnailKey }
    │
    ▼
Admin panel uploads full image + thumbnail directly to R2
    │
    ▼
POST /admin/catalog/items/confirm  { r2Key, thumbnailKey, label, categoryId, sortOrder }
    → API writes to catalog_items table
    → Item immediately available in catalog picker (if is_active=true)
```

Thumbnail generation: either admin uploads both, or API auto-generates thumbnail via a Sharp resize job server-side after confirm.

---

## 6. Database Schema (Full v3)

> Asset/catalog/workflow tables (`model_faces`, `model_backgrounds`, `garment_subcategories`,
> `workflow_templates`, `model_poses`, `catalog_types`, `catalog_categories`, `catalog_items`,
> `catalog_item_subcategories`) are defined in **§3.3**. Core tables below.

```sql
-- Users
CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT UNIQUE NOT NULL,
  password_hash    TEXT,                  -- nullable — Google-only users have no password
  display_name     TEXT,
  tier             TEXT NOT NULL DEFAULT 'FREE',   -- FREE, PRO
  email_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned        BOOLEAN NOT NULL DEFAULT FALSE,
  ban_reason       TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- OAuth (Google) account links
CREATE TABLE oauth_accounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,             -- 'google'
  provider_id  TEXT NOT NULL,
  email        TEXT, display_name TEXT, avatar_url TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (provider, provider_id)
);

-- Credits
CREATE TABLE user_credits (
  user_id   UUID PRIMARY KEY REFERENCES users(id),
  balance   INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE credit_ledger (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id),
  delta       INTEGER NOT NULL,          -- positive=grant, negative=deduct
  reason      TEXT NOT NULL,             -- 'JOB_DISPATCH', 'ADMIN_GRANT', 'REFUND', etc.
  job_id      UUID,                      -- null for manual grants
  admin_id    UUID,                      -- null for system actions
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- User-submitted credit top-up requests (admin approves/rejects)
CREATE TABLE credit_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credits_requested INTEGER NOT NULL,
  credits_approved  INTEGER,
  note              TEXT,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  admin_note        TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at       TIMESTAMPTZ,
  reviewed_by       UUID
);

-- Jobs — one per pose, grouped by catalogue_id
CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  catalogue_id    UUID,                  -- groups jobs created from one studio submit
  status          TEXT NOT NULL DEFAULT 'QUEUED',
  worker_id       TEXT,
  priority        BOOLEAN NOT NULL DEFAULT FALSE,
  credits_charged INTEGER NOT NULL DEFAULT 1,
  attempts        INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE TABLE job_inputs (
  job_id            UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  upper_garment_key TEXT NOT NULL,       -- user-uploaded storage key
  face_id           UUID NOT NULL REFERENCES model_faces(id),
  background_id     UUID NOT NULL REFERENCES model_backgrounds(id),
  pose_id           UUID NOT NULL REFERENCES model_poses(id),
  lower_catalog_id  UUID REFERENCES catalog_items(id),  -- optional
  shoe_catalog_id   UUID REFERENCES catalog_items(id),  -- optional
  user_hint         TEXT,
  params            JSONB
);

CREATE TABLE job_outputs (
  job_id     UUID PRIMARY KEY REFERENCES jobs(id),
  result_key TEXT,                       -- R2 key for result image
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE job_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     UUID REFERENCES jobs(id),
  event_type TEXT NOT NULL,
  payload    JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Asset / catalog / workflow tables: see §3.3

-- Admin
CREATE TABLE admin_users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID UNIQUE REFERENCES users(id),
  role       TEXT NOT NULL DEFAULT 'SUPPORT',   -- SUPER_ADMIN, MODERATOR, SUPPORT
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Refresh tokens (for force-logout support)
CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked    BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 7. Frontend — User Flow (`apps/catalogues-web`, Next.js 15)

Auth via httpOnly cookie (`access_token`); token refresh handled automatically in
`apps/catalogues-web/src/lib/api.ts` (silent single-flight refresh, 1h idle timeout). App routes:
`/studio`, `/catalogues` (+ `/catalogues/[id]`), `/assets`, `/pricing`, `/settings`.

```
Login / Register (email+password or Google) ── email users gated by verification
    │   /verify-email · /verify-email/confirm · /forgot-password · /reset-password
    ▼
Studio (4-step wizard)
    ├── Setup: gender → garment type (modal) → upload garment (presign PUT) → aspect ratio
    ├── AI Models: pick face (filtered by gender)
    ├── Backgrounds: pick background
    ├── Poses: pick 1–6 poses; lower/shoe selectors appear when a chosen pose enables them
    └── Generate → POST /v1/jobs/tryon → one job per pose under a catalogue_id
                 → redirect to /catalogues/{catalogueId}
    │
    ▼
Catalogues
    ├── List: date-grouped, cover thumbnail, polls active jobs; filters + select-all + download-all
    └── Detail: image grid, per-image SSE progress, lightbox, download, delete
                + live platform preview (Amazon mobile/web mockup)
    │
Pricing: plan table + credit top-up (request → admin approval); Razorpay test stub
Settings: profile (GET/PATCH /v1/me), credit history (GET /v1/credits), billing/invoices (stub)
```

---

## 8. Updated API Routes

### User-Facing

| Method        | Endpoint                                             | Auth   | Description                                      |
| ------------- | ---------------------------------------------------- | ------ | ------------------------------------------------ |
| `POST`        | `/v1/auth/register`                                  | —      | Register (sends verification email)              |
| `POST`        | `/v1/auth/login`                                     | —      | Login, returns tokens                            |
| `POST`        | `/v1/auth/refresh`                                   | Cookie | Refresh access token                             |
| `POST`        | `/v1/auth/logout`                                    | JWT    | Revoke refresh token                             |
| `GET`         | `/v1/auth/verify-email`                              | —      | Confirm email via token                          |
| `POST`        | `/v1/auth/resend-verification`                       | —      | Resend verification email                        |
| `POST`        | `/v1/auth/forgot-password`                           | —      | Send password reset email                        |
| `POST`        | `/v1/auth/reset-password`                            | —      | Reset password via token                         |
| `GET`         | `/v1/auth/google/init`                               | —      | Start Google OAuth                               |
| `GET`         | `/v1/auth/google/callback`                           | —      | Google OAuth callback                            |
| `GET`/`PATCH` | `/v1/me`                                             | JWT    | Profile read / update                            |
| `GET`         | `/v1/credits`                                        | JWT    | Balance + recent ledger                          |
| `POST`        | `/v1/credits/requests`                               | JWT    | Submit credit top-up request                     |
| `GET`         | `/v1/catalog/:type`                                  | JWT    | List lower/shoe items (filter by poseIds)        |
| `GET`         | `/v1/models/{faces,backgrounds,poses,subcategories}` | JWT    | Curated assets for the studio wizard             |
| `POST`        | `/v1/uploads/presign`                                | JWT    | Presign garment upload URL                       |
| `POST`        | `/v1/jobs/tryon`                                     | JWT    | Create jobs (one per pose) → `{catalogueId}`     |
| `GET`         | `/v1/jobs` / `/v1/jobs/:id`                          | JWT    | List own jobs / job detail                       |
| `GET`         | `/v1/jobs/:id/events`                                | JWT    | SSE stream (token via `?token=` for EventSource) |
| `GET`         | `/v1/jobs/:id/result`                                | JWT    | Signed result URL                                |
| `GET`         | `/v1/catalogues` / `/v1/catalogues/:id`              | JWT    | Catalogue list / detail (jobs grouped)           |
| `GET`         | `/v1/assets`                                         | JWT    | List user's unique uploaded garments             |

### Admin-Facing (`/admin/*` — requires Admin JWT)

See Section 5.2 for full table.

---

## 9. Monorepo Structure (Updated)

```
/
├── apps/
│   ├── web/             Next.js 15 — user UI (studio, catalogues, pricing, settings)
│   ├── admin/           Vite + React SPA — internal admin panel (separate from web)
│   ├── api/             Fastify 5 — all user + admin endpoints + /results monitor
│   └── dispatcher/      Node.js — Redis consumer, ComfyUI bridge, health monitor
├── packages/
│   ├── types/           Zod schemas — single source of truth for request/response shapes
│   ├── db/              Drizzle ORM schema + migrations + createDb()
│   ├── storage/         StorageProvider interface + R2/MinIO impl + key builders
│   └── logger/          pino wrapper — createLogger(service)
├── infra/
│   ├── docker-compose.yml   postgres + redis + minio (127.0.0.1)
│   └── cloudflared/         Tunnel config templates for worker VPS
├── templates/           ComfyUI workflow JSON (untracked; workflows now stored in DB)
├── scripts/
│   └── seed-catalog.ts
├── pnpm-workspace.yaml
└── .env.example
```

> Workflow templates are now stored in the `workflow_templates` table (uploaded via admin), not as a
> single static file. `packages/catalog` from the v2 plan was not extracted; catalog query helpers
> live in the API modules.

---

## 10. Environment Variables (Updated)

```env
# Workers (dispatcher) — comma-separated IDs + per-worker URL (WORKER_<ID>_URL)
WORKER_IDS=A,B
WORKER_A_URL=https://worker-a.tryon.yourdomain.com   # cloudflared hostname in prod
WORKER_B_URL=https://worker-b.tryon.yourdomain.com
WORKER_API_KEY=<comfyui/worker auth key>

# Storage — R2 in prod, MinIO locally (same StorageProvider interface)
R2_ENDPOINT=https://<acct>.r2.cloudflarestorage.com   # http://127.0.0.1:9000 in dev (MinIO)
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=virtual-tryon-prod
R2_PUBLIC_URL=https://assets.tryon.yourdomain.com
R2_PUBLIC_PRESIGN_BASE=...                            # browser-side presigned URL base

# Database / Cache (bind 127.0.0.1 only)
DATABASE_URL=postgres://tryon:password@127.0.0.1:5432/tryon_prod
REDIS_URL=redis://127.0.0.1:6379

# Auth
JWT_SECRET=...
COOKIE_SECRET=...

# Admin bootstrap (seeds first admin on deploy)
ADMIN_BOOTSTRAP_EMAIL=admin@yourdomain.com
ADMIN_BOOTSTRAP_PASSWORD=...

# Google OAuth (optional)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=...

# Transactional email (verification + password reset)
RESEND_API_KEY=...
EMAIL_FROM=noreply@tryme.com
```

---

## 11. Security Layers (Updated)

| Layer              | Tool                                                | Coverage                                       |
| ------------------ | --------------------------------------------------- | ---------------------------------------------- |
| Edge               | Cloudflare Free                                     | DDoS, OWASP WAF, rate limiting, SSL, CDN       |
| Worker access      | Cloudflare Zero Trust Service Token                 | ComfyUI never publicly reachable               |
| Transport          | HTTPS everywhere via tunnel                         | No open ports on ComfyUI VPS                   |
| Auth               | JWT access + httpOnly refresh + 1h idle timeout     | Session security; silent single-flight refresh |
| Email verification | Resend link, token in Redis; email users gated      | Verified ownership before access               |
| OAuth              | Google OAuth (auto-verified); `oauth_accounts` link | Federated login                                |
| Admin auth         | Separate admin role in JWT + `admin_users` DB check | All /admin routes double-verified              |
| Input validation   | Zod schemas on all endpoints                        | Malformed request rejection                    |
| Catalog validation | All catalog IDs verified active before job creation | Invalid/disabled item rejection                |
| SQL safety         | Drizzle ORM parameterized queries                   | SQLi prevention                                |
| File uploads       | Magic bytes + size (10MB) + dimension checks        | Malicious file prevention                      |
| Headers            | Helmet.js                                           | CSP, HSTS, X-Frame-Options                     |
| Rate limiting      | fastify-rate-limit                                  | Per-user and per-IP                            |
| Internal services  | Postgres + Redis bind to 127.0.0.1 only             | No external exposure                           |
| Prompt             | Injection guard on user hint field                  | Protect system prompt integrity                |
| Force logout       | Refresh token revocation table                      | Admin can terminate any session                |

---

## 12. Sprint Plan (Updated)

| Week       | Deliverables                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Week 1** | Monorepo init, Docker Compose, Drizzle schema (incl. catalog + admin tables), JWT auth + admin roles, credit ledger, R2 StorageProvider, Cloudflare tunnel setup on dev VPS     |
| **Week 2** | Catalog API (browse, category tree), job creation with catalog ID resolution, Redis Stream publisher, Dispatcher with tunnel-based worker routing + health monitor, retry logic |
| **Week 3** | SSE job events, Next.js user UI (upload + catalog picker + job dashboard + result viewer), Admin panel (catalog CRUD, user management, credit controls)                         |
| **Week 4** | End-to-end integration, Hostinger prod VPS setup + tunnel registration, load testing (2-worker queue), admin panel polish, bug fixes, v1 launch                                 |

---

## 13. Open Decisions (Deferred to v2)

| Item                      | Notes                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| Stripe payments           | Free credits at launch; Stripe + pro tier in v2                                                |
| Thumbnail auto-generation | v1: admin uploads both; v2: server-side Sharp resize on catalog upload                         |
| Catalog search/filter     | v1: category tree only; v2: full-text search across catalog items                              |
| CDN for catalog assets    | v1: R2 presigned URLs; v2: public R2 bucket with custom domain for catalog thumbnails          |
| Auto-scale worker VPS     | v1: 2 fixed workers; v2: script to provision additional Hostinger VPS on queue depth threshold |
| Virus scanning            | ClamAV on garment uploads                                                                      |
| Monitoring                | Grafana + Prometheus for GPU util, queue depth, job latency                                    |
| Error tracking            | Sentry for production stack traces                                                             |
| Native HF pipeline        | HuggingFace diffusers port of Qwen-Image-Edit (replaces ComfyUI)                               |
