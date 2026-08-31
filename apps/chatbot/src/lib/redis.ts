import { Redis } from 'ioredis';
import type { Env } from '../env.js';

function retryStrategy(times: number): number | null {
  const delay = Math.min(times * 200, 5000);
  return delay;
}

export function makeRedis(env: Env) {
  const opts = {
    maxRetriesPerRequest: null as null,
    retryStrategy,
    lazyConnect: false,
  };
  const main = new Redis(env.REDIS_URL, opts);
  const pub = new Redis(env.REDIS_URL, opts);
  const sub = new Redis(env.REDIS_URL, opts);

  main.on('error', () => {});
  pub.on('error', () => {});
  sub.on('error', () => {});

  return {
    main,
    pub,
    sub,
    close: async () => {
      await Promise.all([main.quit(), pub.quit(), sub.quit()]);
    },
  };
}
