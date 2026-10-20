import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開発時は /api を API サーバーの /api/staff へ送る。
// 本番は staff.hanamarumusic.com/api を同じように振り分ける（infra の設定）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3000', rewrite: (p) => p.replace(/^\/api/, '/api/staff') },
    },
  },
  preview: { port: 5174 },
});
