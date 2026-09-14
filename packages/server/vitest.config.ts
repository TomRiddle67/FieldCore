import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    // Provide a test-only JWT_SECRET so createServer() does not throw during
    // test module collection.  This value is never used in production.
    env: {
      JWT_SECRET: 'vitest-test-jwt-secret-not-for-production-use',
    },
  },
});
