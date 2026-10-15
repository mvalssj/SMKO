import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    proxy: {
      '/ws': { target: 'ws://localhost:3077', ws: true },
      // The administrator panel is served by the game server.
      '/admin': { target: 'http://localhost:3077' },
    },
  },
});
