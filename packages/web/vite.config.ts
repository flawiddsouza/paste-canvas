import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ command }) => ({
  server: { port: 3000 },
  build: { target: 'esnext' },
  resolve: command === 'serve' ? {
    alias: { '@paste-canvas/lib': resolve(__dirname, '../lib/src/index.ts') },
  } : {},
}));
