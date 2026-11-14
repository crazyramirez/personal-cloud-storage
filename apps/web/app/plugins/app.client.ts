/**
 * Cableado global: sesión caducada → inicio de sesión; las subidas en espera continúan en cuanto
 * el disco vuelve; aviso antes de cerrar la pestaña con subidas en curso.
 */
export default defineNuxtPlugin(() => {
  const session = useSession();
  const storage = useStorage();
  const transfers = useTransfers();
  const router = useRouter();

  onUnauthorized(() => {
    if (session.user.value === null) return;
    session.expire();
    void router.push({ path: '/entrar', query: { volver: router.currentRoute.value.fullPath } });
  });

  watch(storage.writable, (now, before) => {
    if (now && !before) transfers.resumeWaiting();
  });

  window.addEventListener('beforeunload', (event) => {
    if (transfers.busy.value) event.preventDefault();
  });

  // Recursos de una versión anterior que ya no existen (tras desplegar): recarga única.
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    try {
      const last = Number(sessionStorage.getItem('pcloud.reloadedAt') ?? 0);
      if (Date.now() - last < 30_000) return; // evita bucles si el servidor sigue sin el recurso
      sessionStorage.setItem('pcloud.reloadedAt', String(Date.now()));
    } catch {
      // Sin almacenamiento: se recarga igualmente.
    }
    window.location.reload();
  });

  // Errores de JavaScript → registro de la propia Pi (diagnóstico de fallos en móviles).
  let sent = 0;
  const report = (message: string, stack?: string): void => {
    if (sent >= 5 || message === '') return;
    sent += 1;
    const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
    void api('/client-errors', {
      method: 'POST',
      handle401: false,
      body: { message: message.slice(0, 1000), stack: stack?.slice(0, 4000), route: router.currentRoute.value.fullPath.slice(0, 300), standalone },
    }).catch(() => undefined);
  };
  window.addEventListener('error', (event) => report(event.message, event.error instanceof Error ? event.error.stack : undefined));
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    if (reason instanceof ApiError) return; // errores de la API: ya se muestran al usuario
    report(reason instanceof Error ? reason.message : String(reason), reason instanceof Error ? reason.stack : undefined);
  });

  // Sin zoom de página: pellizco (iOS «gesture*», multitáctil) y Ctrl+rueda / Ctrl+± en táctil.
  // El visor de imágenes tiene su propio zoom y gestiona sus gestos.
  const insideViewer = (target: EventTarget | null): boolean => target instanceof Element && target.closest('.viewer') !== null;
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  }
  document.addEventListener('touchmove', (event) => {
    if (event.touches.length > 1 && !insideViewer(event.target)) event.preventDefault();
  }, { passive: false });

  // Instalación como app y service worker (solo en contexto seguro: HTTPS de confianza).
  usePwa();
  useTheme();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }
});
