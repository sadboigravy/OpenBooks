import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During development (`npm run dev`) API calls are proxied to the Flask server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5000',
      '/health': 'http://localhost:5000',
    },
  },
});
