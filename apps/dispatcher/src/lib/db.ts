import { createDb } from '@tryme/db';
import type { Env } from '../env.js';

export function makeDb(env: Env) {
  return createDb(env.DATABASE_URL);
}
