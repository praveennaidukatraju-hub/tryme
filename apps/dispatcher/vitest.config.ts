import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      postgres: resolve(__dirname, '../../packages/db/node_modules/postgres/src/index.js'),
    },
  },
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    include: ['src/**/*.test.ts'],
    // integration/ tests require a live Postgres+Redis — excluded from unit test run
    exclude: ['test/integration/**', '**/node_modules/**', 'dist/**'],
  },
});
