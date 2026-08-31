import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/ci/**/*.test.ts'],
    environment: 'node',
    reporters: ['verbose'],
  },
});
