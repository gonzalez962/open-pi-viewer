import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'server/start.ts',
    outDir: 'dist-server',
    target: 'node22',
    rollupOptions: { output: { entryFileNames: 'start.js' } },
  },
});
