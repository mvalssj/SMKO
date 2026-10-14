import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    proxy: { '/ws': { target: 'ws://localhost:3077', ws: true } },
  },
});
