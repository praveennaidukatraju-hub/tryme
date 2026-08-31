import { resolve } from 'node:path';
import { config } from 'dotenv';

// Vitest doesn't load .env automatically — without this, models-schema.test.ts
// falls back to hardcoded Postgres defaults (e.g. POSTGRES_PORT=5432) instead of
// this machine's actual local config, which can point at an unrelated system-wide
// Postgres install if the docker-compose port was remapped (e.g. to 5433).
config({ path: resolve(process.cwd(), '../../.env') });
