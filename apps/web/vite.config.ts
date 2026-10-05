import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// El panel llama a /v1/* en el mismo origen; en desarrollo Vite lo reenvía a la API.
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.WEB_HOST ?? '127.0.0.1', // WEB_HOST=0.0.0.0 abre el panel a la red local
    port: 5180,
    strictPort: true, // 5173 es la web de Polix en producción: no compartir puerto
    proxy: { '/v1': { target: API, changeOrigin: true } },
  },
});
