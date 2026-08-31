import { Redis } from 'ioredis';
import type { Env } from '../env.js';

function retryStrategy(times: number): number | null {
  return Math.min(times * 200, 5000);
}

export function makeRedis(env: Env) {
  const opts = { lazyConnect: false, maxRetriesPerRequest: null as null, retryStrategy };
  const main = new Redis(env.REDIS_URL, opts);
  const pub = new Redis(env.REDIS_URL, opts);
  main.on('error', () => {});
  pub.on('error', () => {});
  async function close() {
    await main.disconnect();
    await pub.disconnect();
  }
  return { main, pub, close };
}
