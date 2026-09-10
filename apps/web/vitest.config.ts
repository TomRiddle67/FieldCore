import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
    // Two-device E2E tests make real HTTP round-trips to the local sync server
    // and need more than the default 5s timeout.
    testTimeout: 15000,
  },
});
