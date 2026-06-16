import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const BACKEND = process.env.GITHAIKU_BACKEND_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/attestation': { target: BACKEND, changeOrigin: true },
      '/health': { target: BACKEND, changeOrigin: true },
    },
  },
});
