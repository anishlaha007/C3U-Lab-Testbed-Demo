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
    chunkSizeWarningLimit: 2500,
  },
  test: {
    include: ['src/tests/**/*.test.ts'],
    // scratch exploration files (src/tests/_*.test.ts) are excluded unless run explicitly
    exclude: process.env.VITEST_SCRATCH ? [] : ['src/tests/**/_*.test.ts', 'node_modules/**'],
    environment: 'node',
    testTimeout: 60000,
  },
});
