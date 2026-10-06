import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// GitHub Pages 프로젝트 사이트: PAGES_BASE=/busan-bus-transfer/ 로 빌드
export default defineConfig({
  base: process.env.PAGES_BASE ?? '/',
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:5179' } },
  test: { include: ['tests/**/*.test.ts'] },
} as any);
