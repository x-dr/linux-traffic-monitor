import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: Object.fromEntries(['/api', '/downloads'].map(prefix => [prefix, {
    target: process.env.API_URL || 'http://127.0.0.1:8766', changeOrigin: false,
  }])) },
  build: {
    rollupOptions: { output: { manualChunks(id) {
      if (!id.includes('/node_modules/')) return;
      if (/\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id) || id.includes('/@tanstack/')) return 'react-vendor';
      if (id.includes('/@rc-component/') || /\/rc-[^/]+\//.test(id) || id.includes('/antd/') || id.includes('/@ant-design/')) return 'antd-vendor';
    } } },
    chunkSizeWarningLimit: 1000,
  },
});
