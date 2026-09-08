import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
