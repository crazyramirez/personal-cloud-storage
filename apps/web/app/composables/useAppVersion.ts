import type { HealthResponse } from '@pcloud/contracts';

/**
 * Versión de la app y release en ejecución (de /system/health, público). Se pide una vez y se
 * comparte: la barra lateral y Ajustes la muestran.
 */
export function useAppVersion() {
  const info = useState<{ version: string | null; release: string | null } | null>('pcloud-version', () => null);
  const loading = useState('pcloud-version-loading', () => false);
  if (import.meta.client && info.value === null && !loading.value) {
    loading.value = true;
    fetch('/api/v1/system/health', { cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<HealthResponse>) : null))
      .then((health) => {
        if (health !== null) info.value = { version: health.version ?? null, release: health.release ?? null };
      })
      .catch(() => undefined)
      .finally(() => {
        loading.value = false;
      });
  }
  return info;
}
