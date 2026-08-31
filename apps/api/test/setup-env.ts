import { resolve } from 'node:path';
import { config } from 'dotenv';

// Vitest doesn't load .env automatically (unlike `tsx --env-file=` used by dev/start
// scripts) — without this, test/helpers/containers.ts falls back to hardcoded defaults
// (e.g. POSTGRES_PORT=5432) instead of this machine's actual local config. Only fills
// in vars not already set, so an explicit shell export still wins.
config({ path: resolve(process.cwd(), '../../.env') });
