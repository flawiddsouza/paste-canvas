import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ command }) => ({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'chrome120',
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: command === 'serve' ? {
    alias: { '@paste-canvas/lib': resolve(__dirname, '../lib/src/index.ts') },
  } : {},
}));
