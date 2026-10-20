import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** 公開のたびに Service Worker の版を変え、次に開いたときに新しい画面へ切り替える（PW-05） */
function swVersion(): Plugin {
  let outDir = 'dist';
  return {
    name: 'sw-version',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const file = resolve(outDir, 'sw.js');
      writeFileSync(file, readFileSync(file, 'utf8').replace('__BUILD_VERSION__', Date.now().toString(36)));
    },
  };
}

// 開発時は /api を API サーバーの /api/student へ送る。
// 本番は student.hanamarumusic.com/api を同じように振り分ける（infra の設定）
export default defineConfig({
  plugins: [react(), swVersion()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3000', rewrite: (p) => p.replace(/^\/api/, '/api/student') },
    },
  },
  // 本番の作り（Service Worker を含む）を手元で確かめるとき用（e2e の PW-05）
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', rewrite: (p) => p.replace(/^\/api/, '/api/student') },
    },
  },
});
