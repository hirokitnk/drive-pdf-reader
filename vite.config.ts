import { defineConfig } from 'vite';

// GitHub Pages のサブパス配信でも動くよう、相対パスでビルドする
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  test: { include: ['tests/**/*.test.ts'] },
});
