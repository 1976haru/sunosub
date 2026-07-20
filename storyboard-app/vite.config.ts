import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Gemini key used to be injected at build time via `define`, which meant
// changing the key required a rebuild and shipped the key inside the bundle.
// Calls now go through the shared server's /api/story/* proxy instead, so no
// key-related define is needed here anymore.
export default defineConfig({
  base: '/tools/storyboard/',
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  plugins: [react()],
  build: {
    outDir: '../tools/storyboard',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
