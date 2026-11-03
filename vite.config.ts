import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves this repo at https://yongwiit.github.io/Dime/
const base = process.env.BASE_PATH ?? '/Dime/';

export default defineConfig({
  base,
  define: { __APP_VERSION__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 7) ?? 'dev') },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png', 'favicon.png'],
      manifest: {
        name: 'Dime US Portfolio Tracker',
        short_name: 'Dime Port',
        description: 'ติดตามพอร์ตหุ้นสหรัฐฯ ที่ถือผ่าน Dime',
        lang: 'th',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b0f17',
        theme_color: '#0b0f17',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // OCR engine (~11 MB) is not part of app start-up; it is cached the first time screenshot import is used
        globIgnores: ['tesseract/**'],
        navigateFallback: base + 'index.html',
        runtimeCaching: [
          { urlPattern: /\/tesseract\//, handler: 'CacheFirst', options: { cacheName: 'ocr-engine', expiration: { maxEntries: 20 } } },
          { urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//, handler: 'StaleWhileRevalidate', options: { cacheName: 'fonts' } },
        ],
      },
    }),
  ],
  test: { environment: 'node' },
});
