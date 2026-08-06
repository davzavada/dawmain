import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Relative asset URLs so the app works behind Home Assistant ingress
  // (served under /api/hassio_ingress/<token>/) as well as on a direct port.
  base: '',
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
