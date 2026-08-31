import { defineConfig } from 'vitest/config';

// These tests read source files as text and compare them. No DOM, no React
// rendering — `node` is all they need, and it keeps the run under a second.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
