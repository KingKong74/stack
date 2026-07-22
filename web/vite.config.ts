import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      // The web-terminal websockets (#214): /term (xterm sessions), /term-status
      // (the presence pill) and /term-agent (a locally-run daemon dialling in) —
      // without these, the terminal surfaces silently no-op in `npm run dev`.
      '/term': { target: 'http://localhost:4000', changeOrigin: true, ws: true },
      '/term-status': { target: 'http://localhost:4000', changeOrigin: true, ws: true },
      '/term-agent': { target: 'http://localhost:4000', changeOrigin: true, ws: true },
    },
  },
});
