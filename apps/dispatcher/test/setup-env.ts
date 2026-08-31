import { resolve } from 'node:path';
import { config } from 'dotenv';

// Vitest doesn't load .env automatically — without this, test/helpers/containers.ts
// falls back to the hardcoded POSTGRES_PORT default (5432) instead of this machine's
// actual local config, which can point at an unrelated system-wide Postgres install
// if the docker-compose port was remapped (e.g. to 5433). Only fills in vars not
// already set, so an explicit shell export or vitest config `env:` block still wins.
config({ path: resolve(process.cwd(), '../../.env') });
