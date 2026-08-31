import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['./test/setup-env.ts'],
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Each file clones a pre-migrated template DB (test/global-setup.ts) instead of
    // replaying 150+ migrations itself, so concurrent files are cheap — same pattern
    // vitest.integration.config.ts already uses. Capped, not left at CPU-count default,
    // so a small CI runner doesn't fire off dozens of concurrent CREATE DATABASE calls.
    poolOptions: { threads: { maxThreads: 8, minThreads: 1 } },
    // Integration tests in test/integration/ require live localhost Docker services.
    // They are excluded here (unit test run) but should be run in a separate CI job
    // that provisions or starts those services.
    // KNOWN FAILURES (pre-existing, unrelated to this codebase's changes):
    //   jobs-create.test.ts  — uses removed fields modelCatalogId/poseCatalogId/backgroundCatalogId
    //                          from an old job API contract. Needs updating to faceId/backgroundId/poseIds.
    //   catalog.test.ts      — tree structure assertion may not match current catalog API response shape.
    //   e2e.test.ts          — depends on jobs-create flow, fails for the same reason.
    exclude: ['test/integration/**', '**/node_modules/**', 'dist/**'],
  },
});
