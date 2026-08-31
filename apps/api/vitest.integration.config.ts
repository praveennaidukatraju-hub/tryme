import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['./test/setup-env.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Match vitest.config.ts — each file creates a fresh Postgres DB + runs migrations,
    // which routinely exceeds Vitest's 5s/10s defaults and was causing spurious timeouts.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Each file still gets its own Postgres DB + MinIO bucket (cloned from the
    // pre-migrated template in test/global-setup.ts, not migrated from scratch);
    // Redis DB index is assigned per Vitest worker (see containers.ts) so concurrent
    // files no longer race on jobs:*/config:system keys. Capped rather than left at
    // Vitest's CPU-count default so a small CI runner doesn't fire off dozens of
    // concurrent CREATE DATABASE calls against one Postgres instance at once.
    poolOptions: { threads: { maxThreads: 8, minThreads: 1 } },
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});
