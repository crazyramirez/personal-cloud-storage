/*
 * Service worker de Personal Cloud: hace la aplicación instalable y que abra al instante.
 *  - Recursos de la app (/_nuxt/*, iconos): caché, porque su nombre cambia en cada versión.
 *  - Páginas: red primero, pero como mucho NAV_TIMEOUT_MS. Si la red no responde (Tailscale
 *    dormido, fuera de casa, Wi-Fi que se cae), se abre la última versión guardada de la app.
 *    Al guardar una versión nueva se guardan también TODOS sus recursos: la copia siempre arranca
 *    completa (antes, un recurso sin guardar dejaba la app instalada en negro).
 *  - Sin red y sin copia: una página que lo explica y permite reintentar (nunca una pantalla vacía).
 *  - La API (/api/) y las descargas NUNCA se guardan: siempre van al servidor.
 */
const CACHE = 'pcloud-app-v2';
const SHELL = '/200.html';
const MAX_ASSETS = 400;
const NAV_TIMEOUT_MS = 6000;

/** Recursos de la app que referencia un HTML (scripts, estilos, precargas). */
function assetsOf(html) {
  return [...new Set([...html.matchAll(/["'](\/_nuxt\/[^"'?#]+)["']/g)].map((match) => match[1]))];
}

/** Todos los recursos del build actual (precache.json, lo genera scripts/write-precache.mjs). */
async function buildAssets() {
  try {
    const response = await fetch('/precache.json', { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    return Array.isArray(data.assets) ? data.assets.filter((asset) => typeof asset === 'string' && asset.startsWith('/_nuxt/')) : null;
  } catch {
    return null;
  }
}

let storing = null;

/** Guarda el HTML de la app y todos sus recursos (los que falten). Una sola vez a la vez. */
function storeShell(response) {
  storing ??= storeShellNow(response).finally(() => {
    storing = null;
  });
  return storing;
}

async function storeShellNow(response) {
  const html = await response.clone().text();
  const cache = await caches.open(CACHE);
  const listed = await buildAssets();
  const wanted = [...new Set([...(listed ?? []), ...assetsOf(html)])];
  // Todos los recursos del build deben estar ANTES de sustituir la copia de la app: una copia a
  // medias es justo lo que deja la app en negro sin conexión.
  let complete = true;
  await Promise.all(
    wanted.map(async (asset) => {
      if (!asset.startsWith('/_nuxt/builds/') && (await cache.match(asset))) return;
      try {
        const fresh = await fetch(asset, { credentials: 'same-origin', cache: asset.startsWith('/_nuxt/builds/') ? 'no-cache' : 'default' });
        if (fresh.ok) await cache.put(asset, fresh);
        else complete = false;
      } catch {
        complete = false; // sin red: se completará la próxima vez
      }
    }),
  );
  if (!complete && (await cache.match(SHELL))) return; // mejor la copia anterior entera que una nueva a medias
  await cache.put(SHELL, response);
  // Con la lista completa del build, fuera los recursos de versiones anteriores.
  if (listed !== null) {
    const keep = new Set(wanted);
    for (const request of await cache.keys()) {
      const pathname = new URL(request.url).pathname;
      if (pathname.startsWith('/_nuxt/') && !keep.has(pathname)) await cache.delete(request);
    }
  }
  await trim(cache);
}

async function trim(cache) {
  const keys = await cache.keys();
  const assets = keys.filter((request) => new URL(request.url).pathname !== SHELL);
  for (const request of assets.slice(0, Math.max(0, assets.length - MAX_ASSETS))) await cache.delete(request);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    fetch(SHELL, { cache: 'no-store' })
      .then((response) => (response.ok ? storeShell(response) : undefined))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

const OFFLINE_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Sin conexión · Personal Cloud Storage</title>
<style>html,body{margin:0;height:100%;background:#f5f6f8;color:#14171c}@media (prefers-color-scheme:dark){html,body{background:#0f1217;color:#eceef2}}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;box-sizing:border-box;text-align:center;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
p{margin:0;max-width:320px;opacity:.75;font-size:14px}a{display:inline-flex;align-items:center;min-height:44px;padding:0 22px;border-radius:10px;background:#2457d6;color:#fff;font-weight:600;text-decoration:none;margin-top:8px}</style></head>
<body><svg viewBox="0 0 32 32" width="64" height="64" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#2457D6"/><path d="M11 22a5.5 5.5 0 0 1-.7-10.95A6.6 6.6 0 0 1 23 12.5a5 5 0 0 1-.5 9.5z" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>
<strong>No consigo conectar con tu nube</strong><p>Comprueba la conexión. Si estás fuera de casa, abre la app Tailscale y vuelve aquí.</p><a href="">Reintentar</a></body></html>`;

/** La red, pero sin esperar más de `ms`: null si no llega a tiempo o falla. */
function networkWithin(request, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    fetch(request)
      .then((response) => {
        clearTimeout(timer);
        resolve(response);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}

async function navigate(event) {
  const network = fetch(event.request);
  // Si la red responde tarde, la versión nueva se guarda igualmente para la próxima vez.
  event.waitUntil(
    network
      .then((response) => (response.ok && response.type === 'basic' && !response.redirected ? storeShell(response.clone()) : undefined))
      .catch(() => undefined),
  );
  const fast = await Promise.race([network.catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS))]);
  if (fast !== null) return fast;
  const cached = await caches.match(SHELL);
  if (cached) return cached;
  // Sin copia guardada: se espera a la red un poco más y, si no, la página «sin conexión».
  const late = await networkWithin(event.request, 15000);
  return late ?? new Response(OFFLINE_HTML, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/pcloud-ca.crt') return;

  if (request.mode === 'navigate') {
    event.respondWith(navigate(event));
    return;
  }

  // Manifiesto del build: cambia en cada versión con el MISMO nombre → red primero, caché si no hay red.
  if (url.pathname.startsWith('/_nuxt/builds/')) {
    event.respondWith(
      networkWithin(new Request(url.pathname, { cache: 'no-cache', credentials: 'same-origin' }), NAV_TIMEOUT_MS).then(async (response) => {
        if (response !== null && response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
          return response;
        }
        return (await caches.match(url.pathname)) ?? response ?? Response.error();
      }),
    );
    return;
  }

  if (url.pathname.startsWith('/_nuxt/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request, { ignoreVary: true }).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(CACHE).then(async (cache) => {
                await cache.put(request, copy);
                await trim(cache);
              });
            }
            return response;
          }),
      ),
    );
  }
});
