import { createDb, type DB } from '@tryme/db';
import type { Env } from '../env.js';

export function makeDb(env: Env): { db: DB; close: () => Promise<void> } {
  return createDb(env.DATABASE_URL);
}
