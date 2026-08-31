import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    setupFiles: ['./test/setup-env.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    singleFork: true,
  },
});
