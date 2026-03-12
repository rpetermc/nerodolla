import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'fs';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    https: {
      key:  fs.readFileSync('.cert/key.pem'),
      cert: fs.readFileSync('.cert/cert.pem'),
    },
    proxy: {
      // Proxy Lighter backend calls during development.
      // Strip the /lighter prefix so FastAPI routes match (e.g. /lighter/account → /account).
      '/lighter': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/lighter/, ''),
      },
      // Proxy LWS calls to avoid CORS in the browser.
      // Default target is the local wallet-rpc proxy; override via Settings.
      '/lws': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/lws/, '/lws'),
      },
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          'ethers': ['ethers'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['buffer'],
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
});
