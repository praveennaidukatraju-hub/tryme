import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { REGISTRY_KEY, setWorkerStatus, type WorkerEntry } from './registry.js';

function makeFakeRedis(initial: Record<string, WorkerEntry>) {
  const store = new Map(Object.entries(initial).map(([id, entry]) => [id, JSON.stringify(entry)]));
  return {
    async hgetall(key: string) {
      if (key !== REGISTRY_KEY) return {};
      return Object.fromEntries(store);
    },
    async hset(key: string, id: string, json: string) {
      if (key !== REGISTRY_KEY) throw new Error(`unexpected hset key ${key}`);
      store.set(id, json);
    },
    _entry(id: string): WorkerEntry {
      // biome-ignore lint/style/noNonNullAssertion: test helper, caller controls fixture
      return JSON.parse(store.get(id)!) as WorkerEntry;
    },
  };
}

describe('setWorkerStatus', () => {
  it('does not resurrect a worker an admin drained mid-job back to IDLE', async () => {
    const redis = makeFakeRedis({
      w1: {
        url: 'https://w1.example',
        apiKey: 'k',
        status: 'DRAINING',
        lastSeen: 0,
        allowedJobTypes: [],
      },
    });

    // Job release path calling setWorkerStatus(..., 'IDLE') after admin
    // flipped isActive:false while the worker was mid-job.
    await setWorkerStatus(redis as unknown as Redis, 'w1', 'IDLE');

    expect(redis._entry('w1').status).toBe('DRAINING');
  });

  it('still transitions a non-draining worker to IDLE on job release', async () => {
    const redis = makeFakeRedis({
      w1: {
        url: 'https://w1.example',
        apiKey: 'k',
        status: 'BUSY',
        lastSeen: 0,
        allowedJobTypes: [],
      },
    });

    await setWorkerStatus(redis as unknown as Redis, 'w1', 'IDLE');

    expect(redis._entry('w1').status).toBe('IDLE');
  });
});
