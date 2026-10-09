/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Relative base so the static build works from any sub-path (GitHub Pages, Vercel, file server).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // vendor chunks: cached across app updates and downloaded in parallel
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](three|@react-three|three-stdlib|postprocessing|@react-spring|maath|camera-controls|troika)/.test(id)) return 'vendor-three';
          if (/[\\/](recharts|d3-|victory-vendor|decimal\.js|es-toolkit|immer|@reduxjs|redux|reselect)/.test(id)) return 'vendor-charts';
          if (/[\\/](react|react-dom|scheduler|zustand|use-sync-external-store)[\\/]/.test(id)) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
  test: {
    include: ['src/tests/**/*.test.ts'],
    // scratch exploration files (src/tests/_*.test.ts) are excluded unless run explicitly
    exclude: process.env.VITEST_SCRATCH ? [] : ['src/tests/**/_*.test.ts', 'node_modules/**'],
    environment: 'node',
    testTimeout: 60000,
  },
});
