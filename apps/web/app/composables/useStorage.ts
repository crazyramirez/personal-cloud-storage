import type { StorageResponse, VolumeState } from '@pcloud/contracts';

/**
 * Estado del disco según el StorageGuardian del servidor, sondeado cada 5 s mientras la pestaña
 * está visible. La interfaz siempre muestra si el disco físico está disponible (spec §9).
 */
const status = ref<StorageResponse | null>(null);
const unreachable = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;
let consumers = 0;

async function refresh(): Promise<void> {
  try {
    status.value = await api<StorageResponse>('/system/storage');
    unreachable.value = false;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NETWORK') unreachable.value = true;
  }
}

export function useStorage() {
  const state = computed<VolumeState>(() => status.value?.state ?? 'INITIALIZING');
  const readable = computed(() => state.value === 'READY' || state.value === 'READ_ONLY');
  const writable = computed(() => state.value === 'READY');
  const known = computed(() => status.value !== null);

  function start(): void {
    consumers += 1;
    if (timer !== null) return;
    void refresh();
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 5000);
  }

  function stop(): void {
    consumers = Math.max(0, consumers - 1);
    if (consumers === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { status, state, readable, writable, known, unreachable, refresh, start, stop };
}
