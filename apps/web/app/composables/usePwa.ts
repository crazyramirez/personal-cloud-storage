/**
 * Aplicación instalable (PWA): botón «Instalar» cuando el navegador lo permite (Chrome, Edge,
 * Android) e instrucciones para iPhone/iPad, donde se instala con «Compartir → Añadir a inicio».
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const deferred = shallowRef<InstallPromptEvent | null>(null);
const installed = ref(false);
let listening = false;

/** Tamaño base del área de la app en ordenador (píxeles CSS). */
const BASE_WIDTH = 1280;
const BASE_HEIGHT = 720;
const SIZED_KEY = 'pcloud.windowSized';

/**
 * En ordenador, la primera vez que se abre la app instalada su ventana pasa a 1280×720 de
 * contenido, centrada. Solo una vez: después manda el tamaño que elija la persona (el navegador
 * lo recuerda). El manifiesto no tiene un campo para esto; Chrome y Edge permiten `resizeTo`
 * en las ventanas de app.
 */
function sizeDesktopWindow(): void {
  const appWindow = ['standalone', 'window-controls-overlay', 'minimal-ui'].some((mode) => matchMedia(`(display-mode: ${mode})`).matches);
  const desktop = matchMedia('(pointer: fine)').matches && !/Android|iPhone|iPad|iPod/.test(navigator.userAgent);
  if (!appWindow || !desktop) return;
  try {
    if (localStorage.getItem(SIZED_KEY) !== null) return;
    localStorage.setItem(SIZED_KEY, '1');
  } catch {
    return; // sin almacenamiento no se sabría si ya se hizo: mejor no tocar la ventana
  }
  const frameW = Math.max(0, window.outerWidth - window.innerWidth);
  const frameH = Math.max(0, window.outerHeight - window.innerHeight);
  const width = Math.min(BASE_WIDTH + frameW, screen.availWidth);
  const height = Math.min(BASE_HEIGHT + frameH, screen.availHeight);
  const avail = screen as Screen & { availLeft?: number; availTop?: number };
  try {
    window.resizeTo(width, height);
    window.moveTo((avail.availLeft ?? 0) + Math.round((screen.availWidth - width) / 2), (avail.availTop ?? 0) + Math.round((screen.availHeight - height) / 2));
  } catch {
    // El navegador no lo permite: se queda como está.
  }
}

export function usePwa() {
  if (!listening && import.meta.client) {
    listening = true;
    installed.value = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
    sizeDesktopWindow();
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferred.value = event as InstallPromptEvent;
    });
    window.addEventListener('appinstalled', () => {
      deferred.value = null;
      installed.value = true;
    });
  }

  const canInstall = computed(() => deferred.value !== null && !installed.value);
  const isIos = import.meta.client && /iPhone|iPad|iPod/.test(navigator.userAgent);

  async function install(): Promise<boolean> {
    const event = deferred.value;
    if (event === null) return false;
    await event.prompt();
    const choice = await event.userChoice;
    deferred.value = null;
    return choice.outcome === 'accepted';
  }

  return { canInstall, installed, isIos, install };
}
