import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 10_000,
    reporters: 'default',
    env: {
      HARNESS_E2E: process.env.HARNESS_E2E ?? '0',
    },
  },
  resolve: {
    alias: {
      '@harness': new URL('./src', import.meta.url).pathname,
    },
  },
});
