import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const host = process.env.TAURI_DEV_HOST
const isTauri = Boolean(process.env.TAURI_ENV_PLATFORM)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 避免清屏盖住 Rust / Tauri 报错
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    // Browser dev mode: proxy the skin API to the standalone skin-http service
    // (same-origin, so the HTTP adapter works without CORS in dev).
    proxy: {
      '/api': {
        target: process.env.SKIN_HTTP_URL ?? 'http://127.0.0.1:23891',
        changeOrigin: true,
      },
    },
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: isTauri
    ? {
        // Windows=Chromium，macOS/Linux=WebKit
        target:
          process.env.TAURI_ENV_PLATFORM === 'windows'
            ? 'chrome105'
            : 'safari13',
        // Vite 8 默认走 oxc；Monaco worker 仍可能用到 esbuild
        minify: !process.env.TAURI_ENV_DEBUG,
        sourcemap: !!process.env.TAURI_ENV_DEBUG,
      }
    : {},
})
