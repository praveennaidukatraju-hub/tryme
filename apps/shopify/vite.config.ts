import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  envDir: '../../',
  base: process.env.NODE_ENV === 'production' ? '/shopify-admin/' : '/',
  server: {
    host: true,
    port: 5174,
    // Needed to load this dev server through the ngrok tunnel used for local
    // Shopify embedded-app testing (Vite 6's host-check otherwise 403s any
    // Host header it doesn't recognize).
    allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app'],
    // Vite's own built-in CORS middleware runs ahead of the /v1 proxy and
    // answers OPTIONS preflight requests itself (generic headers, no origin
    // awareness) before they ever reach the real API — disable it so
    // preflight actually reaches Fastify's own CORS logic downstream.
    cors: false,
    proxy: {
      '/v1': 'http://127.0.0.1:4001',
    },
  },
});
