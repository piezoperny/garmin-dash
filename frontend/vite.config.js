import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // CRITICAL: GitHub Pages subpath compatibility
  build: {
    outDir: '../dist',
    emptyOutDir: false,
    sourcemap: false,
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    }
  },
  server: {
    port: 3000,
    open: false
  }
});
