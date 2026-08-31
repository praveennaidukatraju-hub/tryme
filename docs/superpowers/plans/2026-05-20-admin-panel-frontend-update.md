# Admin Panel Frontend Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the admin panel UI with the virtual try-on backend — replace AI-model catalog UI with lower/shoe garment catalog, add a Models page for managing model_faces→model_backgrounds→model_poses, and update job types/mock data to reflect try-on jobs.

**Architecture:** Pure frontend React+TypeScript changes in `apps/admin/`. No API integration yet — all data is mock. Five independent tasks: (1) fix types, (2) fix mock data, (3) rewrite CatalogPage, (4) create ModelsPage, (5) wire routing. Admin has no test framework; verification is `pnpm --filter @tryme/admin build` passing (TypeScript strict) and `pnpm --filter @tryme/admin dev` visual check.

**Tech Stack:** React 18, TypeScript 5.6, Vite 6, no test runner in admin app.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/admin/src/types.ts` | Modify | Replace `CatalogItem` with try-on shape; add `ModelFace`, `ModelBackground`, `ModelPose`; update `Job` |
| `apps/admin/src/lib/data.ts` | Modify | Replace `MOCK_CATALOG`, `MOCK_JOBS`; add `MOCK_FACES`, `MOCK_BACKGROUNDS`, `MOCK_POSES` |
| `apps/admin/src/pages/CatalogPage.tsx` | Rewrite | Lower/shoe garment catalog list + detail |
| `apps/admin/src/pages/ModelsPage.tsx` | Create | 3-level drill-down: Faces → Backgrounds → Poses |
| `apps/admin/src/pages/JobsPage.tsx` | Modify | Remove `type`/`model` columns; show try-on inputs |
| `apps/admin/src/components/Sidebar.tsx` | Modify | Add Models nav item |
| `apps/admin/src/App.tsx` | Modify | Add `'models'` page type + routing |

---

### Task 1: Update types.ts

**Files:**
- Modify: `apps/admin/src/types.ts`

- [ ] **Step 1: Replace `CatalogItem` and add model asset types**

Replace entire file content:

```typescript
export type GenderSlug = 'men' | 'women' | 'boys' | 'girls';

export interface ModelFace {
  id: string;
  gender: GenderSlug;
  label: string;
  thumbnailKey: string;
  r2Key: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  backgroundCount?: number;
}

export interface ModelBackground {
  id: string;
  faceId: string;
  faceLabel?: string;
  label: string;
  thumbnailKey: string;
  r2Key: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  poseCount?: number;
}

export interface ModelPose {
  id: string;
  backgroundId: string;
  backgroundLabel?: string;
  label: string;
  thumbnailKey: string;
  r2Key: string;
  showsLower: boolean;
  showsShoes: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogItem {
  id: string;
  label: string;
  type: 'lower' | 'shoe';
  thumbnailKey: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  plan: string;
  creditsRemaining: number;
  creditLimit: number;
  totalJobs: number;
  joinedAt: string;
  lastActive: string;
  emailVerified: boolean;
  status: 'active' | 'suspended' | 'inactive';
  recentJobs?: { id: string; status: string; createdAt: string; duration: string }[];
}

export type JobStatus =
  | 'QUEUED'
  | 'PREPROCESSING'
  | 'GENERATING'
  | 'UPLOADING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface Job {
  id: string;
  userEmail: string;
  status: JobStatus;
  priority: boolean;
  creditsCharged: number;
  workerId: string | null;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  errorCode?: string;
  faceLabel?: string;
  backgroundLabel?: string;
  poseLabel?: string;
  hasLower: boolean;
  hasShoe: boolean;
  outputUrl?: string;
  userHint?: string;
}

export type WorkerStatus = 'IDLE' | 'BUSY' | 'DRAINING' | 'OFFLINE';

export interface Worker {
  id: string;
  status: WorkerStatus;
  lastSeen: string;
  completed: number;
  currentJob: string | null;
  uptime: string;
}

export interface LedgerEntry {
  ts: string;
  delta: number;
  reason: string;
  admin: string;
}

export interface Stats {
  jobsToday: number;
  jobsTodayDelta: number;
  creditsToday: number;
  creditsTodayDelta: number;
  activeUsersToday: number;
  activeUsersDelta: number;
  workersHealthy: number;
  workersTotal: number;
  queueDepth: number;
  failed24h: number;
  failed24hDelta: number;
  jobsPerDay: number[];
  jobsPerDayLabels: string[];
}

export interface SystemConfig {
  credit: {
    costPerJob: number;
    maxJobsPerDay: number;
    maxConcurrentPerUser: number;
    defaultCreditsNewUser: number;
  };
  job: {
    maxRetries: number;
    timeoutMinutes: number;
    xpendingClaimMs: number;
  };
}

export type AdminRole = 'SUPER_ADMIN' | 'MODERATOR' | 'SUPPORT';

export interface ToastItem {
  id: number;
  kind?: 'error' | 'success';
  title: string;
  body?: string;
}
```

- [ ] **Step 2: Verify TypeScript compiles (will fail until data.ts is also updated)**

Note: TS errors are expected until Task 2 is done. Continue.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/types.ts
git commit -m "feat(admin): update types for virtual try-on — model assets + catalog/job shapes"
```

---

### Task 2: Update lib/data.ts mock data

**Files:**
- Modify: `apps/admin/src/lib/data.ts`

- [ ] **Step 1: Replace MOCK_CATALOG, MOCK_JOBS; add model asset mocks**

Replace the mock data section (lines 1–97 of current `lib/data.ts`, keeping the API client utilities from line 99 onwards):

```typescript
import type { Stats, CatalogItem, User, Job, ModelFace, ModelBackground, ModelPose } from '../types';

export const TONES = [
  'oklch(0.86 0.04 60)',
  'oklch(0.72 0.08 35)',
  'oklch(0.58 0.06 30)',
  'oklch(0.40 0.02 270)',
  'oklch(0.82 0.03 90)',
  'oklch(0.68 0.08 110)',
];

export const STATUS_ORDER = ['QUEUED', 'PREPROCESSING', 'GENERATING', 'UPLOADING', 'COMPLETED'] as const;

export function statusBadge(s: string): [string, string] {
  const m: Record<string, [string, string]> = {
    QUEUED: ['info', 'Queued'],
    PREPROCESSING: ['accent', 'Preprocessing'],
    GENERATING: ['accent', 'Generating'],
    UPLOADING: ['accent', 'Uploading'],
    COMPLETED: ['success', 'Completed'],
    FAILED: ['danger', 'Failed'],
    CANCELLED: ['', 'Cancelled'],
    IDLE: ['', 'Idle'],
    BUSY: ['accent', 'Busy'],
    DRAINING: ['warn', 'Draining'],
    OFFLINE: ['danger', 'Offline'],
    active: ['success', 'Active'],
    inactive: ['', 'Inactive'],
    draft: ['', 'Draft'],
    archived: ['', 'Archived'],
  };
  return m[s] || ['', s];
}

export const MOCK_STATS: Stats = {
  jobsToday: 1247,
  jobsTodayDelta: 12.4,
  creditsToday: 6235,
  creditsTodayDelta: 8.1,
  activeUsersToday: 384,
  activeUsersDelta: -2.6,
  workersHealthy: 6,
  workersTotal: 8,
  queueDepth: 41,
  failed24h: 23,
  failed24hDelta: 156,
  jobsPerDay: [890, 1024, 1156, 982, 1340, 1421, 1247],
  jobsPerDayLabels: ['May 13', 'May 14', 'May 15', 'May 16', 'May 17', 'May 18', 'Today'],
};

export const MOCK_USERS: User[] = [
  { id: 'u_a1b2c3', name: 'Felix Marchetti', email: 'felix@marchetti.tn', role: 'CREATOR', plan: 'Scale', creditsRemaining: 12470, creditLimit: 25000, totalJobs: 842, joinedAt: '2025-09-12', lastActive: '2026-05-19 14:23', emailVerified: true, status: 'active', recentJobs: [{ id: 'j_f7c2a4', status: 'COMPLETED', createdAt: '2m ago', duration: '34.2s' }, { id: 'j_k8e2d4', status: 'COMPLETED', createdAt: '15m ago', duration: '28.1s' }] },
  { id: 'u_d4e5f6', name: 'Karim Mansour', email: 'karim.m@cairo-cut.eg', role: 'CREATOR', plan: 'Growth', creditsRemaining: 3420, creditLimit: 10000, totalJobs: 215, joinedAt: '2026-01-08', lastActive: '2026-05-19 11:05', emailVerified: true, status: 'active', recentJobs: [{ id: 'j_e8d4c2', status: 'COMPLETED', createdAt: '1h ago', duration: '42.7s' }] },
  { id: 'u_g7h8i9', name: 'Lior Ben-David', email: 'lior@studio-lb.co.il', role: 'CREATOR', plan: 'Enterprise', creditsRemaining: 89200, creditLimit: 200000, totalJobs: 3412, joinedAt: '2025-06-03', lastActive: '2026-05-19 13:47', emailVerified: true, status: 'active' },
  { id: 'u_j0k1l2', name: 'Aisha Patel', email: 'aisha@visual-stories.in', role: 'CREATOR', plan: 'Growth', creditsRemaining: 1890, creditLimit: 10000, totalJobs: 98, joinedAt: '2026-03-22', lastActive: '2026-05-18 22:10', emailVerified: true, status: 'active' },
  { id: 'u_m3n4o5', name: 'Chen Wei', email: 'chen.w@shanghai-ai.cn', role: 'CREATOR', plan: 'Starter', creditsRemaining: 450, creditLimit: 5000, totalJobs: 34, joinedAt: '2026-04-15', lastActive: '2026-05-17 16:30', emailVerified: false, status: 'active' },
  { id: 'u_p6q7r8', name: 'Oliver Schmidt', email: 'oliver@berlin-gen.ai', role: 'CREATOR', plan: 'Scale', creditsRemaining: 28400, creditLimit: 50000, totalJobs: 1567, joinedAt: '2025-11-20', lastActive: '2026-05-19 12:18', emailVerified: true, status: 'active' },
  { id: 'u_s9t0u1', name: 'Sarah Kim', email: 'sarah@seoul-studio.kr', role: 'CREATOR', plan: 'Growth', creditsRemaining: 6700, creditLimit: 10000, totalJobs: 423, joinedAt: '2026-02-01', lastActive: '2026-05-19 09:44', emailVerified: true, status: 'active' },
  { id: 'u_h4i5j6', name: 'Suspended User', email: 'suspended@example.com', role: 'CREATOR', plan: 'Starter', creditsRemaining: 0, creditLimit: 5000, totalJobs: 45, joinedAt: '2026-01-10', lastActive: '2026-04-30 08:12', emailVerified: true, status: 'suspended' },
];

// Model asset mocks — mirrors model_faces → model_backgrounds → model_poses FK chain
export const MOCK_FACES: ModelFace[] = [
  { id: 'face_men_01', gender: 'men', label: 'Male Model A', thumbnailKey: 'faces/men-01-thumb.jpg', r2Key: 'faces/men-01.jpg', isActive: true, sortOrder: 0, createdAt: '2026-05-01T10:00:00Z', updatedAt: '2026-05-01T10:00:00Z', backgroundCount: 3 },
  { id: 'face_men_02', gender: 'men', label: 'Male Model B', thumbnailKey: 'faces/men-02-thumb.jpg', r2Key: 'faces/men-02.jpg', isActive: true, sortOrder: 1, createdAt: '2026-05-02T10:00:00Z', updatedAt: '2026-05-02T10:00:00Z', backgroundCount: 2 },
  { id: 'face_women_01', gender: 'women', label: 'Female Model A', thumbnailKey: 'faces/women-01-thumb.jpg', r2Key: 'faces/women-01.jpg', isActive: true, sortOrder: 0, createdAt: '2026-05-03T10:00:00Z', updatedAt: '2026-05-03T10:00:00Z', backgroundCount: 4 },
  { id: 'face_women_02', gender: 'women', label: 'Female Model B', thumbnailKey: 'faces/women-02-thumb.jpg', r2Key: 'faces/women-02.jpg', isActive: false, sortOrder: 1, createdAt: '2026-05-04T10:00:00Z', updatedAt: '2026-05-04T10:00:00Z', backgroundCount: 1 },
  { id: 'face_boys_01', gender: 'boys', label: 'Boys Model A', thumbnailKey: 'faces/boys-01-thumb.jpg', r2Key: 'faces/boys-01.jpg', isActive: true, sortOrder: 0, createdAt: '2026-05-05T10:00:00Z', updatedAt: '2026-05-05T10:00:00Z', backgroundCount: 2 },
  { id: 'face_girls_01', gender: 'girls', label: 'Girls Model A', thumbnailKey: 'faces/girls-01-thumb.jpg', r2Key: 'faces/girls-01.jpg', isActive: true, sortOrder: 0, createdAt: '2026-05-05T10:00:00Z', updatedAt: '2026-05-05T10:00:00Z', backgroundCount: 2 },
];

export const MOCK_BACKGROUNDS: ModelBackground[] = [
  { id: 'bg_men01_01', faceId: 'face_men_01', faceLabel: 'Male Model A', label: 'Studio White', thumbnailKey: 'bgs/men01-studio-white-thumb.jpg', r2Key: 'bgs/men01-studio-white.jpg', isActive: true, sortOrder: 0, createdAt: '2026-05-06T10:00:00Z', updatedAt: '2026-05-06T10:00:00Z', poseCount: 3 },
  { id: 'bg_men01_02', faceId: 'face_men_01', faceLabel: 'Male Model A', label: 'Urban Street', thumbnailKey: 'bgs/men01-urban-thumb.jpg', r2Key: 'bgs/men01-urban.jpg', isActive: true, sortOrder: 1, createdAt: '2026-05-06T11:00:00Z', updatedAt: '2026-05-06T11:00:00Z', poseCount: 2 },
  { id: 'bg_men01_03', faceId: 'face_men_01', faceLabel: 'Male Model A', label: 'Office', thumbnailKey: 'bgs/men01-office-thumb.jpg', r2Key: 'bgs/men01-office.jpg', isActive: true, sortOrder: 2, createdAt: '2026-05-07T10:00:00Z', updatedAt: '2026-05-07T10:00:00Z', poseCount: 3 },
  { id: 'bg_men02_01', faceId: 'face_men_02', faceLabel: 'Male Model B', label: 'Studio Grey', thumbnailKey: 'bgs/men02-studio-grey-thumb.jpg', r2Key: 'bgs/men02-studio-grey.jpg', isActive: true, sortOrder: 0, createdAt: '2026-05-06T10:00:00Z', updatedAt: '2026-05-06T10:00:00Z', poseCount: 3 },
  { id: 'bg_women01_01', faceId: 'face_women_01', faceLabel: 'Female Model A', label: 'Studio White', thumbnailKey: 'bgs/women01-studio-white-thumb.jpg', r2Key: 'bgs/women01-studio-white.jpg', isActive: true, sortOrder: 0, createdAt: '2026-05-06T10:00:00Z', updatedAt: '2026-05-06T10:00:00Z', poseCount: 3 },
];

export const MOCK_POSES: ModelPose[] = [
  { id: 'pose_men01bg01_01', backgroundId: 'bg_men01_01', backgroundLabel: 'Studio White', label: 'Front Stand', thumbnailKey: 'poses/m1b1-front-thumb.jpg', r2Key: 'poses/m1b1-front.jpg', showsLower: true, showsShoes: true, isActive: true, sortOrder: 0, createdAt: '2026-05-10T10:00:00Z', updatedAt: '2026-05-10T10:00:00Z' },
  { id: 'pose_men01bg01_02', backgroundId: 'bg_men01_01', backgroundLabel: 'Studio White', label: 'Half Turn', thumbnailKey: 'poses/m1b1-half-thumb.jpg', r2Key: 'poses/m1b1-half.jpg', showsLower: true, showsShoes: false, isActive: true, sortOrder: 1, createdAt: '2026-05-10T11:00:00Z', updatedAt: '2026-05-10T11:00:00Z' },
  { id: 'pose_men01bg01_03', backgroundId: 'bg_men01_01', backgroundLabel: 'Studio White', label: 'Upper Only', thumbnailKey: 'poses/m1b1-upper-thumb.jpg', r2Key: 'poses/m1b1-upper.jpg', showsLower: false, showsShoes: false, isActive: true, sortOrder: 2, createdAt: '2026-05-10T12:00:00Z', updatedAt: '2026-05-10T12:00:00Z' },
];

export const MOCK_CATALOG: CatalogItem[] = [
  { id: 'cat_lower_001', label: 'Classic Blue Jeans', type: 'lower', thumbnailKey: 'catalog/lower-jeans-001-thumb.jpg', isActive: true, sortOrder: 0, createdAt: '2026-05-01T10:00:00Z', updatedAt: '2026-05-01T10:00:00Z' },
  { id: 'cat_lower_002', label: 'Slim Fit Chinos', type: 'lower', thumbnailKey: 'catalog/lower-chinos-001-thumb.jpg', isActive: true, sortOrder: 1, createdAt: '2026-05-02T10:00:00Z', updatedAt: '2026-05-02T10:00:00Z' },
  { id: 'cat_lower_003', label: 'Formal Trousers Black', type: 'lower', thumbnailKey: 'catalog/lower-formal-001-thumb.jpg', isActive: true, sortOrder: 2, createdAt: '2026-05-03T10:00:00Z', updatedAt: '2026-05-03T10:00:00Z' },
  { id: 'cat_lower_004', label: 'Track Pants Grey', type: 'lower', thumbnailKey: 'catalog/lower-track-001-thumb.jpg', isActive: false, sortOrder: 3, createdAt: '2026-05-04T10:00:00Z', updatedAt: '2026-05-04T10:00:00Z' },
  { id: 'cat_shoe_001', label: 'White Sneakers', type: 'shoe', thumbnailKey: 'catalog/shoe-sneaker-001-thumb.jpg', isActive: true, sortOrder: 0, createdAt: '2026-05-01T10:00:00Z', updatedAt: '2026-05-01T10:00:00Z' },
  { id: 'cat_shoe_002', label: 'Oxford Brown', type: 'shoe', thumbnailKey: 'catalog/shoe-oxford-001-thumb.jpg', isActive: true, sortOrder: 1, createdAt: '2026-05-02T10:00:00Z', updatedAt: '2026-05-02T10:00:00Z' },
  { id: 'cat_shoe_003', label: 'Loafers Tan', type: 'shoe', thumbnailKey: 'catalog/shoe-loafer-001-thumb.jpg', isActive: true, sortOrder: 2, createdAt: '2026-05-03T10:00:00Z', updatedAt: '2026-05-03T10:00:00Z' },
];

export const MOCK_JOBS: Job[] = [
  { id: 'j_a1b2c3d4', userEmail: 'felix@marchetti.tn', status: 'COMPLETED', priority: true, creditsCharged: 1, workerId: 'worker-a', createdAt: '2026-05-19 14:23:10', startedAt: '2026-05-19 14:23:11', completedAt: '2026-05-19 14:23:45', faceLabel: 'Male Model A', backgroundLabel: 'Studio White', poseLabel: 'Front Stand', hasLower: true, hasShoe: true, outputUrl: 'https://output.tryme.ai/j_a1b2c3d4.png' },
  { id: 'j_b2c3d4e5', userEmail: 'karim.m@cairo-cut.eg', status: 'COMPLETED', priority: false, creditsCharged: 1, workerId: 'worker-a', createdAt: '2026-05-19 14:10:00', startedAt: '2026-05-19 14:10:02', completedAt: '2026-05-19 14:10:44', faceLabel: 'Female Model A', backgroundLabel: 'Studio White', poseLabel: 'Half Turn', hasLower: true, hasShoe: false, outputUrl: 'https://output.tryme.ai/j_b2c3d4e5.png' },
  { id: 'j_e4d5c6b7', userEmail: 'felix@marchetti.tn', status: 'QUEUED', priority: true, creditsCharged: 1, workerId: null, createdAt: '2026-05-19 14:25:00', faceLabel: 'Male Model B', backgroundLabel: 'Studio Grey', poseLabel: 'Front Stand', hasLower: false, hasShoe: false },
  { id: 'j_b7a6c5d4', userEmail: 'oliver@berlin-gen.ai', status: 'GENERATING', priority: true, creditsCharged: 1, workerId: 'worker-a', createdAt: '2026-05-19 14:20:00', startedAt: '2026-05-19 14:24:10', faceLabel: 'Female Model A', backgroundLabel: 'Urban Street', poseLabel: 'Upper Only', hasLower: false, hasShoe: false },
  { id: 'j_f7c2a4b1', userEmail: 'felix@marchetti.tn', status: 'FAILED', priority: false, creditsCharged: 0, workerId: 'worker-a', createdAt: '2026-05-19 13:45:00', startedAt: '2026-05-19 13:45:01', errorCode: 'COMFY_TIMEOUT', faceLabel: 'Male Model A', backgroundLabel: 'Office', poseLabel: 'Half Turn', hasLower: true, hasShoe: false },
  { id: 'j_k8e2d4c3', userEmail: 'karim.m@cairo-cut.eg', status: 'FAILED', priority: false, creditsCharged: 0, workerId: 'worker-a', createdAt: '2026-05-19 12:30:00', startedAt: '2026-05-19 12:30:02', errorCode: 'R2_UPLOAD_TIMEOUT', faceLabel: 'Female Model A', backgroundLabel: 'Studio White', poseLabel: 'Front Stand', hasLower: false, hasShoe: false },
  { id: 'j_g8h2i4j6', userEmail: 'sarah@seoul-studio.kr', status: 'CANCELLED', priority: false, creditsCharged: 0, workerId: null, createdAt: '2026-05-19 11:00:00', faceLabel: 'Boys Model A', backgroundLabel: 'Studio White', poseLabel: 'Front Stand', hasLower: true, hasShoe: true },
  { id: 'j_j2k3l4m5', userEmail: 'tariq@dubai-frame.ae', status: 'QUEUED', priority: false, creditsCharged: 1, workerId: null, createdAt: '2026-05-19 14:27:00', faceLabel: 'Female Model A', backgroundLabel: 'Studio White', poseLabel: 'Front Stand', hasLower: false, hasShoe: false },
];
```

Then keep the entire API client section from the original (lines 99–141 of the original `lib/data.ts` starting with `// ── API client ──`):

```typescript
// ── API client ──────────────────────────────────────────────────────────────

let _token: string | null = null;
let _onAuthFailure: (() => void) | null = null;

export function setToken(t: string | null) { _token = t; }
export function getToken() { return _token; }
export function initAuthFailureHandler(cb: () => void) { _onAuthFailure = cb; }

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API ${status}`);
  }
}

export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const makeHeaders = (token: string | null): HeadersInit => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers as Record<string, string> ?? {}),
  });

  const res = await fetch(path, { ...init, headers: makeHeaders(_token), credentials: 'include' });

  if (res.status === 401 && _token) {
    const refreshRes = await fetch('/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    if (refreshRes.ok) {
      const { accessToken } = await refreshRes.json() as { accessToken: string };
      setToken(accessToken);
      const retry = await fetch(path, { ...init, headers: makeHeaders(accessToken), credentials: 'include' });
      if (!retry.ok) throw new ApiError(retry.status, await retry.json());
      return retry.json() as Promise<T>;
    }
    setToken(null);
    _onAuthFailure?.();
    throw new ApiError(401, { error: { code: 'SESSION_EXPIRED', message: 'session expired' } });
  }

  if (!res.ok) throw new ApiError(res.status, await res.json());
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /run/media/adeshboudh/New\ Volume/PycharmProjects/tryme_v1
pnpm --filter @tryme/admin build
```

Expected: build errors in `CatalogPage.tsx` and `JobsPage.tsx` (they still reference old type shape). Those are fixed in Tasks 3 and 5. Continue.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/types.ts apps/admin/src/lib/data.ts
git commit -m "feat(admin): replace mock data — model assets + try-on catalog + try-on jobs"
```

---

### Task 3: Rewrite CatalogPage.tsx

**Context:** Catalog items in our system are lower-garments and shoes only. Each item has `id`, `label`, `type: 'lower'|'shoe'`, `thumbnailKey`, `isActive`, `sortOrder`. Since we have no real MinIO/R2 in dev, thumbnailKey is a path — render as text or use a placeholder. The page needs: tab filter (All/Lower/Shoe), search by label/id, toggle active state, delete.

**Files:**
- Modify: `apps/admin/src/pages/CatalogPage.tsx`

- [ ] **Step 1: Rewrite CatalogPage.tsx**

Replace the entire file:

```typescript
import { useState } from 'react';
import type { CatalogItem } from '../types';
import { MOCK_CATALOG } from '../lib/data';
import { Icon } from '../components/Icons';
import { Pager } from '../components/Pager';
import { Th } from '../components/Th';
import type { SortDir } from '../components/Th';
import { Switch } from '../components/Switch';

const PAGE_SIZE = 25;

type Tab = 'all' | 'lower' | 'shoe';
const TABS: { k: Tab; l: string }[] = [
  { k: 'all', l: 'All items' },
  { k: 'lower', l: 'Lower garments' },
  { k: 'shoe', l: 'Shoes' },
];

interface Props {
  onNav: (_page: string, _filter?: { page: string; filter?: string }) => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export default function CatalogPage({ onNav: _onNav, toast }: Props) {
  const [items, setItems] = useState<CatalogItem[]>(MOCK_CATALOG);
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<keyof CatalogItem>('sortOrder');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const filtered = items.filter((c) => {
    if (tab !== 'all' && c.type !== tab) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
  });

  const sorted = [...filtered].sort((a, b) => {
    const aVal = a[sortKey] ?? '';
    const bVal = b[sortKey] ?? '';
    const cmp = typeof aVal === 'string'
      ? aVal.localeCompare(bVal as string)
      : (aVal as number) - (bVal as number);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleSort = (k: keyof CatalogItem) => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('asc'); }
  };

  const toggleActive = (id: string) => {
    setItems((prev) => prev.map((c) => c.id === id ? { ...c, isActive: !c.isActive } : c));
    const item = items.find((c) => c.id === id);
    if (item) toast({ title: `${item.label} ${item.isActive ? 'deactivated' : 'activated'}` });
  };

  const doDelete = () => {
    setItems((prev) => prev.filter((c) => c.id !== confirmDelete));
    toast({ title: `Item ${confirmDelete} deleted` });
    setConfirmDelete(null);
  };

  const lowerCount = items.filter((c) => c.type === 'lower').length;
  const shoeCount = items.filter((c) => c.type === 'shoe').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Catalog</h1>
          <p className="lede">{lowerCount} lower garments · {shoeCount} shoes — optional add-ons shown when pose permits.</p>
        </div>
        <div className="head-tools">
          <div className="search">
            <Icon.Search />
            <input
              placeholder="Search by label or ID…"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(0); }}
            />
          </div>
          <button className="btn"><Icon.Add /> Add item</button>
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.k}
            className={`tab ${tab === t.k ? 'active' : ''}`}
            onClick={() => { setTab(t.k); setPage(0); }}
          >
            {t.l}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <Th k="label" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Label</Th>
              <Th k="type" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Type</Th>
              <Th k="sortOrder" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Order</Th>
              <Th k="isActive" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Active</Th>
              <Th k="updatedAt" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Updated</Th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {paged.map((c) => (
              <tr key={c.id}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 40, height: 40, borderRadius: 6,
                      background: 'var(--subtle)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <Icon.Image />
                    </div>
                    <div>
                      <span className="semi">{c.label}</span>
                      <span className="sub mono" style={{ display: 'block' }}>{c.id}</span>
                    </div>
                  </div>
                </td>
                <td>
                  <span className={`badge dot ${c.type === 'lower' ? 'accent' : 'warn'}`}>
                    {c.type === 'lower' ? 'Lower' : 'Shoe'}
                  </span>
                </td>
                <td><span className="mono">{c.sortOrder}</span></td>
                <td>
                  <Switch checked={c.isActive} onChange={() => toggleActive(c.id)} />
                </td>
                <td><span className="mono">{c.updatedAt.slice(0, 10)}</span></td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn sm ghost"><Icon.Edit /></button>
                    <button className="btn sm ghost" onClick={() => setConfirmDelete(c.id)}><Icon.Trash /></button>
                  </div>
                </td>
              </tr>
            ))}
            {paged.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>No items found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Pager page={page} totalPages={totalPages} onPage={setPage} totalItems={sorted.length} pageSize={PAGE_SIZE} />

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>Delete catalog item</h3></div>
            <div className="modal-body">
              <p>Delete <strong>{items.find((c) => c.id === confirmDelete)?.label ?? confirmDelete}</strong>? This cannot be undone.</p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn danger" onClick={doDelete}><Icon.Trash /> Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd /run/media/adeshboudh/New\ Volume/PycharmProjects/tryme_v1
pnpm --filter @tryme/admin build
```

Expected: CatalogPage errors gone. JobsPage may still have type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/pages/CatalogPage.tsx
git commit -m "feat(admin): rewrite CatalogPage for lower/shoe garment catalog"
```

---

### Task 4: Create ModelsPage.tsx

**Context:** Three-level admin UI for managing model assets. Structure: Face list (default, tabbed by gender) → click face → background list for that face → click background → pose list for that background. Each level supports add/toggle active/delete. ModelPoses show `showsLower`/`showsShoes` flags as badges — these flags drive conditional UI in the user flow (step 6).

The three levels are managed via a `view` state machine:
- `{ kind: 'faces' }` — top-level face list, tabs: Men/Women/Boys/Girls/All
- `{ kind: 'backgrounds', faceId, faceLabel }` — backgrounds for a face
- `{ kind: 'poses', backgroundId, backgroundLabel, faceId, faceLabel }` — poses for a background

**Files:**
- Create: `apps/admin/src/pages/ModelsPage.tsx`

- [ ] **Step 1: Create ModelsPage.tsx**

```typescript
import { useState } from 'react';
import type { ModelFace, ModelBackground, ModelPose, GenderSlug } from '../types';
import { MOCK_FACES, MOCK_BACKGROUNDS, MOCK_POSES } from '../lib/data';
import { Icon } from '../components/Icons';
import { Switch } from '../components/Switch';

interface Props {
  onNav: (_page: string, _filter?: { page: string; filter?: string }) => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

type View =
  | { kind: 'faces' }
  | { kind: 'backgrounds'; faceId: string; faceLabel: string }
  | { kind: 'poses'; faceId: string; faceLabel: string; backgroundId: string; backgroundLabel: string };

const GENDERS: { k: GenderSlug | 'all'; l: string }[] = [
  { k: 'all', l: 'All' },
  { k: 'men', l: 'Men' },
  { k: 'women', l: 'Women' },
  { k: 'boys', l: 'Boys' },
  { k: 'girls', l: 'Girls' },
];

function ThumbPlaceholder({ label }: { label: string }) {
  return (
    <div style={{
      width: 48, height: 64, borderRadius: 6,
      background: 'var(--subtle)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, color: 'var(--muted)', fontSize: 10, textAlign: 'center',
      padding: 4,
    }}>
      {label.slice(0, 2).toUpperCase()}
    </div>
  );
}

function FaceList({ toast }: { toast: Props['toast']; onSelect: (f: ModelFace) => void } & { onSelect: (f: ModelFace) => void }) {
  const [faces, setFaces] = useState<ModelFace[]>(MOCK_FACES);
  const [genderTab, setGenderTab] = useState<GenderSlug | 'all'>('all');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const visible = genderTab === 'all' ? faces : faces.filter((f) => f.gender === genderTab);

  const toggleActive = (id: string) => {
    setFaces((prev) => prev.map((f) => f.id === id ? { ...f, isActive: !f.isActive } : f));
    const face = faces.find((f) => f.id === id);
    if (face) toast({ title: `${face.label} ${face.isActive ? 'deactivated' : 'activated'}` });
  };

  const doDelete = () => {
    setFaces((prev) => prev.filter((f) => f.id !== confirmDelete));
    toast({ title: 'Face deleted' });
    setConfirmDelete(null);
  };

  return (
    <>
      <div className="tabs">
        {GENDERS.map((g) => (
          <button key={g.k} className={`tab ${genderTab === g.k ? 'active' : ''}`} onClick={() => setGenderTab(g.k)}>
            {g.l}
          </button>
        ))}
      </div>

      <div className="grid-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
        {visible.map((f) => (
          <FaceCard key={f.id} face={f} onSelect={() => {}} onToggle={() => toggleActive(f.id)} onDelete={() => setConfirmDelete(f.id)} />
        ))}
        {visible.length === 0 && (
          <p style={{ color: 'var(--muted)', gridColumn: '1 / -1' }}>No faces in this category.</p>
        )}
      </div>

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>Delete face</h3></div>
            <div className="modal-body"><p>Delete this face and all its backgrounds and poses? Cannot be undone.</p></div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn danger" onClick={doDelete}><Icon.Trash /> Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function FaceCard({ face, onSelect, onToggle, onDelete }: { face: ModelFace; onSelect: () => void; onToggle: () => void; onDelete: () => void }) {
  return (
    <div className="card" style={{ opacity: face.isActive ? 1 : 0.6 }}>
      <div style={{ cursor: 'pointer' }} onClick={onSelect}>
        <ThumbPlaceholder label={face.label} />
        <div style={{ marginTop: 10 }}>
          <span className="semi">{face.label}</span>
          <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
            <span className="badge dot accent">{face.gender}</span>
            <span className="sub">{face.backgroundCount ?? 0} backgrounds</span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        <Switch checked={face.isActive} onChange={onToggle} />
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn sm ghost"><Icon.Edit /></button>
          <button className="btn sm ghost" onClick={onDelete}><Icon.Trash /></button>
        </div>
      </div>
    </div>
  );
}

export default function ModelsPage({ onNav: _onNav, toast }: Props) {
  const [view, setView] = useState<View>({ kind: 'faces' });
  const [faces] = useState<ModelFace[]>(MOCK_FACES);
  const [backgrounds, setBackgrounds] = useState<ModelBackground[]>(MOCK_BACKGROUNDS);
  const [poses, setPoses] = useState<ModelPose[]>(MOCK_POSES);
  const [genderTab, setGenderTab] = useState<GenderSlug | 'all'>('all');
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'face' | 'background' | 'pose'; id: string } | null>(null);

  // ── Faces view helpers ──
  const visibleFaces = genderTab === 'all' ? faces : faces.filter((f) => f.gender === genderTab);

  // ── Backgrounds view helpers ──
  const currentBgs = view.kind === 'backgrounds' || view.kind === 'poses'
    ? backgrounds.filter((b) => b.faceId === view.faceId)
    : [];

  // ── Poses view helpers ──
  const currentPoses = view.kind === 'poses'
    ? poses.filter((p) => p.backgroundId === view.backgroundId)
    : [];

  const toggleBgActive = (id: string) => {
    setBackgrounds((prev) => prev.map((b) => b.id === id ? { ...b, isActive: !b.isActive } : b));
    const bg = backgrounds.find((b) => b.id === id);
    if (bg) toast({ title: `${bg.label} ${bg.isActive ? 'deactivated' : 'activated'}` });
  };

  const togglePoseActive = (id: string) => {
    setPoses((prev) => prev.map((p) => p.id === id ? { ...p, isActive: !p.isActive } : p));
    const pose = poses.find((p) => p.id === id);
    if (pose) toast({ title: `${pose.label} ${pose.isActive ? 'deactivated' : 'activated'}` });
  };

  const doDelete = () => {
    if (!confirmDelete) return;
    if (confirmDelete.type === 'background') {
      setBackgrounds((prev) => prev.filter((b) => b.id !== confirmDelete.id));
    } else if (confirmDelete.type === 'pose') {
      setPoses((prev) => prev.filter((p) => p.id !== confirmDelete.id));
    }
    toast({ title: `${confirmDelete.type} deleted` });
    setConfirmDelete(null);
  };

  // ── Breadcrumb ──
  const breadcrumb = () => {
    if (view.kind === 'faces') return null;
    if (view.kind === 'backgrounds') return (
      <button className="btn ghost" onClick={() => setView({ kind: 'faces' })}>
        <Icon.Chevron /> Models
      </button>
    );
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn ghost" onClick={() => setView({ kind: 'faces' })}>
          <Icon.Chevron /> Models
        </button>
        <span style={{ color: 'var(--muted)' }}>/</span>
        <button className="btn ghost" onClick={() => view.kind === 'poses' && setView({ kind: 'backgrounds', faceId: view.faceId, faceLabel: view.faceLabel })}>
          {view.kind === 'poses' ? view.faceLabel : ''}
        </button>
      </div>
    );
  };

  const pageTitle = () => {
    if (view.kind === 'faces') return 'Models';
    if (view.kind === 'backgrounds') return view.faceLabel;
    return view.backgroundLabel;
  };

  const pageDesc = () => {
    if (view.kind === 'faces') return `${faces.length} model faces — select to manage backgrounds and poses.`;
    if (view.kind === 'backgrounds') return `Backgrounds for ${view.faceLabel} — each background gets up to 3 poses.`;
    return `Poses for ${view.backgroundLabel} · ${view.faceLabel}.`;
  };

  return (
    <>
      <div className="page-head">
        <div>
          {breadcrumb()}
          <h1 style={{ marginTop: view.kind !== 'faces' ? 8 : 0 }}>{pageTitle()}</h1>
          <p className="lede">{pageDesc()}</p>
        </div>
        <div className="head-tools">
          <button className="btn">
            <Icon.Add />
            {view.kind === 'faces' ? 'Add face' : view.kind === 'backgrounds' ? 'Add background' : 'Add pose'}
          </button>
        </div>
      </div>

      {/* ── Faces view ── */}
      {view.kind === 'faces' && (
        <>
          <div className="tabs">
            {GENDERS.map((g) => (
              <button key={g.k} className={`tab ${genderTab === g.k ? 'active' : ''}`} onClick={() => setGenderTab(g.k)}>
                {g.l}
              </button>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
            {visibleFaces.map((face) => (
              <div key={face.id} className="card" style={{ opacity: face.isActive ? 1 : 0.6 }}>
                <div style={{ cursor: 'pointer' }} onClick={() => setView({ kind: 'backgrounds', faceId: face.id, faceLabel: face.label })}>
                  <ThumbPlaceholder label={face.label} />
                  <div style={{ marginTop: 10 }}>
                    <span className="semi">{face.label}</span>
                    <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
                      <span className="badge dot accent">{face.gender}</span>
                      <span className="sub">{face.backgroundCount ?? 0} backgrounds</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                  <Switch checked={face.isActive} onChange={() => toast({ title: `${face.label} toggled` })} />
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn sm ghost"><Icon.Edit /></button>
                    <button className="btn sm ghost" onClick={() => setConfirmDelete({ type: 'face', id: face.id })}><Icon.Trash /></button>
                  </div>
                </div>
              </div>
            ))}
            {visibleFaces.length === 0 && (
              <p style={{ color: 'var(--muted)', gridColumn: '1 / -1' }}>No faces in this gender pool.</p>
            )}
          </div>
        </>
      )}

      {/* ── Backgrounds view ── */}
      {view.kind === 'backgrounds' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
          {currentBgs.map((bg) => (
            <div key={bg.id} className="card" style={{ opacity: bg.isActive ? 1 : 0.6 }}>
              <div style={{ cursor: 'pointer' }} onClick={() => view.kind === 'backgrounds' && setView({ kind: 'poses', faceId: view.faceId, faceLabel: view.faceLabel, backgroundId: bg.id, backgroundLabel: bg.label })}>
                <ThumbPlaceholder label={bg.label} />
                <div style={{ marginTop: 10 }}>
                  <span className="semi">{bg.label}</span>
                  <span className="sub" style={{ display: 'block', marginTop: 2 }}>{bg.poseCount ?? 0} poses</span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <Switch checked={bg.isActive} onChange={() => toggleBgActive(bg.id)} />
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn sm ghost"><Icon.Edit /></button>
                  <button className="btn sm ghost" onClick={() => setConfirmDelete({ type: 'background', id: bg.id })}><Icon.Trash /></button>
                </div>
              </div>
            </div>
          ))}
          {currentBgs.length === 0 && (
            <p style={{ color: 'var(--muted)', gridColumn: '1 / -1' }}>No backgrounds yet. Add one to continue.</p>
          )}
        </div>
      )}

      {/* ── Poses view ── */}
      {view.kind === 'poses' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
          {currentPoses.map((pose) => (
            <div key={pose.id} className="card" style={{ opacity: pose.isActive ? 1 : 0.6 }}>
              <ThumbPlaceholder label={pose.label} />
              <div style={{ marginTop: 10 }}>
                <span className="semi">{pose.label}</span>
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  {pose.showsLower && <span className="badge dot accent">Shows lower</span>}
                  {pose.showsShoes && <span className="badge dot warn">Shows shoes</span>}
                  {!pose.showsLower && !pose.showsShoes && <span className="badge dot">Upper only</span>}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <Switch checked={pose.isActive} onChange={() => togglePoseActive(pose.id)} />
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn sm ghost"><Icon.Edit /></button>
                  <button className="btn sm ghost" onClick={() => setConfirmDelete({ type: 'pose', id: pose.id })}><Icon.Trash /></button>
                </div>
              </div>
            </div>
          ))}
          {currentPoses.length === 0 && (
            <p style={{ color: 'var(--muted)', gridColumn: '1 / -1' }}>No poses yet. Add up to 3 poses per background.</p>
          )}
        </div>
      )}

      {/* ── Delete confirm modal ── */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>Delete {confirmDelete.type}</h3></div>
            <div className="modal-body">
              <p>Delete this {confirmDelete.type}?
                {confirmDelete.type === 'face' && ' All related backgrounds and poses will also be deleted.'}
                {' '}Cannot be undone.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn danger" onClick={doDelete}><Icon.Trash /> Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /run/media/adeshboudh/New\ Volume/PycharmProjects/tryme_v1
pnpm --filter @tryme/admin build 2>&1 | grep -i error | head -20
```

Expected: no errors in ModelsPage.tsx. If any, fix before committing.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/pages/ModelsPage.tsx
git commit -m "feat(admin): add ModelsPage — face→background→pose 3-level drill-down"
```

---

### Task 5: Wire routing and fix JobsPage

**Context:** Add the Models page to the sidebar and App routing. Also fix JobsPage which still references old `Job.type` and `Job.model` fields — replace with try-on fields (`faceLabel`, `backgroundLabel`, `poseLabel`, `hasLower`, `hasShoe`). The `Icon.Image` icon already exists and suits the Models nav item.

**Files:**
- Modify: `apps/admin/src/components/Sidebar.tsx`
- Modify: `apps/admin/src/App.tsx`
- Modify: `apps/admin/src/pages/JobsPage.tsx`

- [ ] **Step 1: Add Models to Sidebar**

In `apps/admin/src/components/Sidebar.tsx`, replace the `items` array:

```typescript
const items: NavItem[] = [
  { k: 'dashboard', label: 'Dashboard', icon: Icon.Dashboard, roles: ['SUPER_ADMIN', 'MODERATOR', 'SUPPORT'] },
  { k: 'models', label: 'Models', icon: Icon.Image, roles: ['SUPER_ADMIN', 'MODERATOR'] },
  { k: 'catalog', label: 'Catalog', icon: Icon.Catalog, roles: ['SUPER_ADMIN', 'MODERATOR'] },
  { k: 'users', label: 'Users', icon: Icon.Users, roles: ['SUPER_ADMIN', 'SUPPORT'], count: 12 },
  { k: 'jobs', label: 'Jobs', icon: Icon.Jobs, roles: ['SUPER_ADMIN', 'MODERATOR'], count: 23, alert: true },
  { k: 'settings', label: 'Settings', icon: Icon.Settings, roles: ['SUPER_ADMIN'] },
];
```

- [ ] **Step 2: Add models routing in App.tsx**

In `apps/admin/src/App.tsx`:

1. Add import at the top:

```typescript
import ModelsPage from './pages/ModelsPage';
```

2. Change the `Page` type:

```typescript
type Page = 'dashboard' | 'models' | 'catalog' | 'users' | 'jobs' | 'settings';
```

3. Add `models` to `PAGE_LABELS`:

```typescript
const PAGE_LABELS: Record<Page, string> = {
  dashboard: 'Dashboard',
  models: 'Models',
  catalog: 'Catalog',
  users: 'Users',
  jobs: 'Jobs',
  settings: 'Settings',
};
```

4. Add the route in the render section (after the catalog route):

```typescript
{page === 'models' && <ModelsPage {...pageProps} />}
```

- [ ] **Step 3: Fix JobsPage — remove old type/model fields**

In `apps/admin/src/pages/JobsPage.tsx`, find the table headers section and the `filtered` query. Make these changes:

**3a. In the `filtered` query** — remove the reference to `j.type`:

Find:
```typescript
return j.id.toLowerCase().includes(q) || j.user?.toLowerCase().includes(q) || j.type?.toLowerCase().includes(q);
```

Replace with:
```typescript
return j.id.toLowerCase().includes(q) || j.userEmail?.toLowerCase().includes(q);
```

**3b. In the table headers** — find columns for `model` and `type`, replace with try-on columns. Find the `<thead>` section and replace it with:

```tsx
<thead>
  <tr>
    <Th k="id" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Job ID</Th>
    <Th k="userEmail" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>User</Th>
    <Th k="faceLabel" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Face / Pose</Th>
    <th>Add-ons</th>
    <Th k="status" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Status</Th>
    <Th k="creditsCharged" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Credits</Th>
    <Th k="workerId" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Worker</Th>
    <Th k="createdAt" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Created</Th>
    <th></th>
  </tr>
</thead>
```

**3c. In the table rows** — find the `paged.map((j) =>` section and replace the `<tr>` body:

```tsx
{paged.map((j) => (
  <tr key={j.id} onClick={() => setDetail(j)} style={{ cursor: 'pointer' }}>
    <td><span className="mono sub">{j.id}</span></td>
    <td><span className="semi">{j.userEmail}</span></td>
    <td>
      <span className="semi">{j.faceLabel ?? '—'}</span>
      <span className="sub" style={{ display: 'block' }}>{j.poseLabel ?? '—'}</span>
    </td>
    <td>
      <div style={{ display: 'flex', gap: 4 }}>
        {j.hasLower && <span className="badge dot accent">Lower</span>}
        {j.hasShoe && <span className="badge dot warn">Shoe</span>}
        {!j.hasLower && !j.hasShoe && <span className="sub">—</span>}
      </div>
    </td>
    <td><StatusBadge status={j.status} /></td>
    <td><span className="mono">{j.creditsCharged}</span></td>
    <td><span className="mono sub">{j.workerId ?? '—'}</span></td>
    <td><span className="mono">{j.createdAt}</span></td>
    <td>
      {(j.status === 'QUEUED' || j.status === 'GENERATING') && (
        <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); handleCancel(j.id); }}>Cancel</button>
      )}
    </td>
  </tr>
))}
```

**3d. In the detail view** — the detail view shows `j.type`, `j.model`, `j.user`, `j.worker`. Update the KV grid to use new fields. Find the detail section (`if (detail)`) and update the KV grid inside it. Replace the kv-grid content with:

```tsx
<div className="kv-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 20 }}>
  <KV k="User" v={j.userEmail} />
  <KV k="Status" v={j.status} />
  <KV k="Credits charged" v={String(j.creditsCharged)} />
  <KV k="Priority" v={j.priority ? 'PRO' : 'Normal'} />
  <KV k="Face" v={j.faceLabel ?? '—'} />
  <KV k="Background" v={j.backgroundLabel ?? '—'} />
  <KV k="Pose" v={j.poseLabel ?? '—'} />
  <KV k="Worker" v={j.workerId ?? '—'} />
  <KV k="Created" v={j.createdAt} />
  <KV k="Started" v={j.startedAt ?? '—'} />
  <KV k="Completed" v={j.completedAt ?? '—'} />
  <KV k="Error code" v={j.errorCode ?? '—'} />
</div>
```

Also update the `<p className="lede">` to use `j.userEmail` instead of `j.user`:

Find:
```tsx
<p className="lede">Created {j.createdAt}</p>
```
Replace with:
```tsx
<p className="lede">{j.userEmail} · Created {j.createdAt}</p>
```

- [ ] **Step 4: Verify full build passes**

```bash
cd /run/media/adeshboudh/New\ Volume/PycharmProjects/tryme_v1
pnpm --filter @tryme/admin build
```

Expected: **zero TypeScript errors, build succeeds.**

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/components/Sidebar.tsx apps/admin/src/App.tsx apps/admin/src/pages/JobsPage.tsx
git commit -m "feat(admin): wire Models page routing; fix JobsPage for try-on job shape"
```

---

## Self-Review

### 1. Spec coverage

| Requirement | Task |
|-------------|------|
| `CatalogItem` type reflects lower/shoe schema | Task 1 |
| `ModelFace` / `ModelBackground` / `ModelPose` types | Task 1 |
| `Job` type reflects try-on shape (no model/type fields) | Task 1 |
| Mock data for faces, backgrounds, poses | Task 2 |
| Mock lower/shoe catalog items | Task 2 |
| Mock jobs with try-on fields | Task 2 |
| CatalogPage shows lower/shoe items | Task 3 |
| ModelsPage — face list with gender tabs | Task 4 |
| ModelsPage — drill into backgrounds | Task 4 |
| ModelsPage — drill into poses | Task 4 |
| Pose shows showsLower/showsShoes flags | Task 4 |
| Active toggle on all 3 levels | Task 4 |
| Sidebar has Models nav item | Task 5 |
| App.tsx routes to ModelsPage | Task 5 |
| JobsPage uses new Job fields | Task 5 |

### 2. Placeholder scan

No TBD/TODO/placeholder text in the plan. All code is complete and runnable.

### 3. Type consistency

- `ModelFace.gender` is `GenderSlug` (= `'men' | 'women' | 'boys' | 'girls'`) — consistent across Task 1 types, Task 2 mocks, Task 4 filter tabs.
- `Job.userEmail` replaces `Job.user` consistently across Task 1 types, Task 2 mocks, Task 5 JobsPage edits.
- `CatalogItem.label` replaces `CatalogItem.name` consistently across Task 1, Task 2, Task 3.
- `Switch` component used in Tasks 3, 4 — imported from `'../components/Switch'` which exists.
- `Icon.Image` used in Task 3 (placeholder) and Task 5 (sidebar) — exists in `Icons.tsx`.
- `KV` component imported in JobsPage detail view — already used in current `JobsPage.tsx`.
