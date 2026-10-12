import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// vitest@2.x ships vite@5 internally while the app uses vite@6 directly.
// The Plugin types are structurally incompatible at the type level only; at
// runtime both resolve to the same installed vite@6 binary.  Casting react()
// to `any` satisfies the vitest/config overloads without weakening any logic.
export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [react() as any],
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      '/sync': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  test: {
    // Two-device E2E tests make real HTTP round-trips against the local sync
    // server and need more time than the default 5s timeout.
    testTimeout: 15000,
  },
});
