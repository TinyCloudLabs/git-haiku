import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Default to the portless backend URL (https://api.githaiku.localhost). Under
// portless, NODE_EXTRA_CA_CERTS is auto-set so this Vite process trusts the
// local CA, and `changeOrigin: true` below avoids the 508 proxy loop. The plain
// (non-portless) `dev:plain` script overrides this with http://127.0.0.1:8787.
const BACKEND = process.env.GITHAIKU_BACKEND_URL ?? 'https://api.githaiku.localhost';

export default defineConfig({
  plugins: [react()],
  server: {
    // Honor portless's assigned port: portless sets PORT in the env, but Vite
    // ignores PORT (it only respects --port, which portless can't inject when it
    // launches via pnpm). Reading it here binds Vite where portless routes to
    // (otherwise → 502). For plain `dev:plain` (no PORT), Vite uses its default.
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    // Bind IPv4 explicitly: portless connects to 127.0.0.1, but Vite's default
    // "localhost" resolves to IPv6 ::1 on this machine → portless 502s. Matches
    // the backend, which also binds 127.0.0.1.
    host: '127.0.0.1',
    proxy: {
      // changeOrigin rewrites Host so portless routes to the backend (avoids the
      // 508 loop); secure:false lets Vite's proxy accept the portless local-CA
      // cert on the HTTPS upstream.
      '/api': { target: BACKEND, changeOrigin: true, secure: false },
      '/attestation': { target: BACKEND, changeOrigin: true, secure: false },
      '/health': { target: BACKEND, changeOrigin: true, secure: false },
    },
  },
});
