import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      postgres: new URL('../../packages/db/node_modules/postgres/src/index.js', import.meta.url)
        .pathname,
    },
  },
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});
