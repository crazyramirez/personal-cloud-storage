// Panel web de Personal Cloud Storage: SPA estática (spec §4). Sin SSR, sin telemetría y sin
// recursos de terceros en tiempo de ejecución (las fuentes van empaquetadas).

// Marcador que Caddy cambia por el Host de la petición (ver «templates» en Caddyfile.tmpl).
const OG_HOST = '%%PCS{.Host}%%';

export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  ssr: false,
  telemetry: false,
  devtools: { enabled: false },
  css: [
    '@fontsource-variable/inter/index.css',
    '@fontsource/jetbrains-mono/400.css',
    '@fontsource/jetbrains-mono/500.css',
    '~/assets/css/main.css',
  ],
  app: {
    head: {
      title: 'Personal Cloud Storage',
      htmlAttrs: { lang: 'es' },
      meta: [
        // viewport-fit=cover: la app instalada ocupa toda la pantalla (zonas seguras con env()).
        { name: 'viewport', content: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover' },
        { name: 'color-scheme', content: 'light dark' },
        { name: 'robots', content: 'noindex, nofollow' },
        { name: 'referrer', content: 'no-referrer' },
        { name: 'theme-color', content: '#f6f7f9', media: '(prefers-color-scheme: light)' },
        { name: 'theme-color', content: '#0f1217', media: '(prefers-color-scheme: dark)' },
        { name: 'application-name', content: 'PCS' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-title', content: 'PCS' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
        { name: 'format-detection', content: 'telephone=no' },
        // Vista previa al compartir la dirección (WhatsApp, Telegram, iMessage…). og:image tiene
        // que ser una URL absoluta y el nombre cambia según por dónde se entre (<host>.local, la IP,
        // Tailscale): Caddy sustituye el marcador por el Host de la petición (directiva templates
        // del Caddyfile, solo en HTML). Sin Caddy (nuxt dev) queda el marcador, sin más efecto.
        { property: 'og:type', content: 'website' },
        { property: 'og:site_name', content: 'Personal Cloud Storage' },
        { property: 'og:title', content: 'Personal Cloud Storage' },
        { property: 'og:description', content: 'Tu nube personal en casa: un servidor pequeño, un disco USB y nada más.' },
        { property: 'og:image', content: `https://${OG_HOST}/og-image.jpg` },
        { property: 'og:image:type', content: 'image/jpeg' },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '630' },
        { property: 'og:image:alt', content: 'Personal Cloud Storage' },
        { name: 'twitter:card', content: 'summary_large_image' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/icons/favicon-32.png' },
        { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
        { rel: 'manifest', href: '/manifest.webmanifest' },
      ],
    },
  },
  // Solo para `nuxt dev` en el ordenador de desarrollo: la API real está en la Raspberry Pi.
  vite: {
    // Ningún recurso incrustado como data: (fuentes pequeñas incluidas): la CSP solo permite
    // fuentes e imágenes servidas por la propia aplicación ('self').
    build: { assetsInlineLimit: 0 },
    server: {
      proxy: { '/api': { target: process.env.PCLOUD_API ?? 'https://pcloud.local', changeOrigin: true, secure: false } },
    },
  },
  typescript: { typeCheck: false },
  // Tras desplegar una versión nueva, una pestaña abierta puede pedir fragmentos que ya no
  // existen: se recarga sola en ese momento en lugar de quedarse rota.
  experimental: { emitRouteChunkError: 'automatic-immediate' },
});
