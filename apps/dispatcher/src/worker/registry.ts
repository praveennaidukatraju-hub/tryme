import type { WorkerPool } from '@tryme/types';
import type { Redis } from 'ioredis';

export type WorkerStatus = 'IDLE' | 'BUSY' | 'DRAINING';

export interface WorkerEntry {
  url: string;
  apiKey: string;
  status: WorkerStatus;
  lastSeen: number; // unix ms
  allowedJobTypes: WorkerPool[]; // empty = accept all
}

export const REGISTRY_KEY = 'worker:registry';

export function healthKey(workerId: string) {
  return `worker:health:${workerId}`;
}

export async function getWorkers(redis: Redis): Promise<Map<string, WorkerEntry>> {
  const raw = await redis.hgetall(REGISTRY_KEY);
  const map = new Map<string, WorkerEntry>();
  for (const [id, json] of Object.entries(raw)) {
    try {
      map.set(id, JSON.parse(json) as WorkerEntry);
    } catch {
      /* skip malformed */
    }
  }
  return map;
}

export async function setWorkerStatus(
  redis: Redis,
  workerId: string,
  status: WorkerStatus,
): Promise<void> {
  const workers = await getWorkers(redis);
  const entry = workers.get(workerId);
  if (!entry) return;
  // A job release (status IDLE) must not resurrect a worker an admin drained
  // mid-job — DRAINING sticks until an explicit undrain or a startup resync.
  // Without this guard, deactivating a BUSY worker gets silently undone the
  // instant its in-flight job finishes.
  if (status === 'IDLE' && entry.status === 'DRAINING') return;
  entry.status = status;
  entry.lastSeen = Date.now();
  await redis.hset(REGISTRY_KEY, workerId, JSON.stringify(entry));
}

export async function registerWorkers(
  redis: Redis,
  workers: Array<{ id: string; url: string; apiKey: string; allowedJobTypes?: WorkerPool[] }>,
): Promise<void> {
  // Remove stale entries: any worker in Redis but not in the DB list is deleted.
  // This prevents old env-var workers from lingering after being removed from the DB.
  const existing = await redis.hkeys(REGISTRY_KEY);
  const incoming = new Set(workers.map((w) => w.id));
  for (const id of existing) {
    if (!incoming.has(id)) {
      await redis.hdel(REGISTRY_KEY, id);
      await redis.del(healthKey(id));
    }
  }

  for (const w of workers) {
    const entry: WorkerEntry = {
      url: w.url,
      apiKey: w.apiKey,
      status: 'IDLE',
      lastSeen: Date.now(),
      allowedJobTypes: w.allowedJobTypes ?? [],
    };
    await redis.hset(REGISTRY_KEY, w.id, JSON.stringify(entry));
  }
}

export async function deregisterWorker(redis: Redis, workerId: string): Promise<void> {
  await redis.hdel(REGISTRY_KEY, workerId);
  await redis.del(healthKey(workerId));
}
