import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// one id per build; compiled into the app AND published as /version.json so a stale copy can notice it is out of date
const BUILD_ID = Date.now().toString(36)

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    {
      name: 'snapnote-version',
      generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id: BUILD_ID }) }) },
    },
    react(),
    VitePWA({
      // 'prompt' = a new deploy never force-reloads the page. Pages come from the network first (below), so people
      // always get the newest version on their next open without the old-then-reload flicker.
      registerType: 'prompt',
      includeAssets: ['favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png', 'logo.svg'],
      manifest: {
        name: 'Snapnote',
        short_name: 'Snapnote',
        description: 'Send text to a friend\'s screen, live.',
        theme_color: '#dcdfec',
        background_color: '#dcdfec',
        display: 'standalone',
        orientation: 'portrait',
        id: '/',
        start_url: '/',
        scope: '/',
        display_override: ['standalone', 'minimal-ui'],
        categories: ['social', 'communication'],
        launch_handler: { client_mode: 'navigate-existing' },   // links open the already-running app window
        shortcuts: [
          { name: 'Friends', url: '/friends', icons: [{ src: 'icon-192.png', sizes: '192x192' }] },
          { name: 'Devices', url: '/devices', icons: [{ src: 'icon-192.png', sizes: '192x192' }] },
        ],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        importScripts: ['push-sw.js'], // "X is calling you" notifications while the app is closed
        // precache the hashed app files only; HTML is fetched fresh (network-first) so a deploy is visible immediately
        globPatterns: ['**/*.{js,css,svg,png,ico,woff2}'],
        navigateFallback: undefined,
        runtimeCaching: [
          {
            // every page request → the network first (fast timeout), falling back to the last app shell when offline.
            // One cache key for all routes: it's a single-page app, so the same index.html serves every screen.
            urlPattern: ({ request }: { request: Request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'snapnote-shell',
              networkTimeoutSeconds: 4,
              plugins: [{ cacheKeyWillBeUsed: async () => '/index.html' }],
            },
          },
        ],
      },
    }),
  ],
})
