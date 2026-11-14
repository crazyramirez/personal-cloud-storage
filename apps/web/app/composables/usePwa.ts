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

export function usePwa() {
  if (!listening && import.meta.client) {
    listening = true;
    installed.value = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
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
