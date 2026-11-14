import type { UploadCompleteResponse, UploadInitResponse } from '@pcloud/contracts';

/**
 * Cola de subidas reanudables (ADR-0010): bloques secuenciales por offset, 2 archivos a la vez.
 * Si el disco o la red fallan, la subida queda «en espera» y continúa sola desde el último punto
 * que el servidor tiene confirmado; nunca se reinicia desde cero ni se da por buena sin confirmar.
 */

export type TransferState = 'queued' | 'uploading' | 'paused' | 'waiting' | 'error' | 'done' | 'cancelled';

export interface Transfer {
  id: number;
  file: File;
  name: string;
  /** Carpeta de destino (ruta del cliente). */
  dest: string;
  size: number;
  uploaded: number;
  state: TransferState;
  /** Bytes por segundo (ventana móvil). */
  speed: number;
  /** Aviso del estado, en el idioma activo (se traduce al leerlo). */
  readonly message: string;
  /** Clave de traducción del aviso («transfers.…»), o '' si no hay. */
  messageKey: string;
  /** Texto ya listo (mensaje de error del servidor) cuando no hay clave. */
  messageText: string;
  /** Nombre final si el servidor tuvo que cambiarlo para no sobrescribir. */
  finalName: string | null;
  /**
   * La subida terminada ya no debe mostrarse dentro de la carpeta: el archivo real ya apareció
   * en el listado (o pasaron unos segundos). Si después se elimina, no vuelve a «aparecer».
   */
  settled: boolean;
  uploadId: string | null;
  chunkSize: number;
  attempts: number;
}

const MAX_PARALLEL = 2;
const UPLOAD_CONTENT_TYPE = 'application/offset+octet-stream';
const UPLOAD_OFFSET_HEADER = 'upload-offset';
const SPEED_WINDOW_MS = 5000;

const transfers = ref<Transfer[]>([]);
/** Panel de subidas de la cabecera (desplegable en ordenador, pantalla completa en el móvil). */
const panelOpen = ref(false);
/** Aumenta cada vez que termina una subida: las vistas lo observan para refrescar listados. */
const completedTick = ref(0);
const lastCompletedDest = ref('');
let nextId = 1;
const controllers = new Map<number, AbortController>();
const samples = new Map<number, Array<[number, number]>>();
const retryTimers = new Map<number, ReturnType<typeof setTimeout>>();

function drop(id: number): void {
  transfers.value = transfers.value.filter((item) => item.id !== id);
}

function find(id: number): Transfer | undefined {
  return transfers.value.find((item) => item.id === id);
}

function trackSpeed(transfer: Transfer): void {
  const now = performance.now();
  const list = samples.get(transfer.id) ?? [];
  list.push([now, transfer.uploaded]);
  while (list.length > 2 && now - (list[0]?.[0] ?? now) > SPEED_WINDOW_MS) list.shift();
  samples.set(transfer.id, list);
  const first = list[0];
  if (first !== undefined && now - first[0] > 250) {
    transfer.speed = ((transfer.uploaded - first[1]) * 1000) / (now - first[0]);
  }
}

function scheduleRetry(transfer: Transfer): void {
  const delay = Math.min(30_000, 2000 * 2 ** Math.min(transfer.attempts, 4));
  transfer.attempts += 1;
  clearTimeout(retryTimers.get(transfer.id));
  retryTimers.set(
    transfer.id,
    setTimeout(() => {
      retryTimers.delete(transfer.id);
      if (transfer.state === 'waiting') {
        transfer.state = 'queued';
        pump();
      }
    }, delay),
  );
}

async function run(transfer: Transfer): Promise<void> {
  transfer.state = 'uploading';
  transfer.messageKey = '';
  transfer.messageText = '';
  const controller = new AbortController();
  controllers.set(transfer.id, controller);
  const signal = controller.signal;
  try {
    if (transfer.uploadId === null) {
      const init = await api<UploadInitResponse>('/uploads', {
        method: 'POST',
        body: { path: transfer.dest, name: transfer.name, size: transfer.size },
        signal,
      });
      transfer.uploadId = init.id;
      transfer.chunkSize = init.chunkSize;
      transfer.uploaded = init.offset;
    } else {
      // Reanudación: el servidor dice desde dónde continuar (solo cuenta lo que confirmó en disco).
      const current = await api<{ offset: number }>(`/uploads/${transfer.uploadId}`, { signal });
      transfer.uploaded = current.offset;
    }

    while (transfer.uploaded < transfer.size) {
      const end = Math.min(transfer.uploaded + transfer.chunkSize, transfer.size);
      const response = await apiResponse(`/uploads/${transfer.uploadId}`, {
        method: 'PATCH',
        raw: transfer.file.slice(transfer.uploaded, end),
        headers: { 'content-type': UPLOAD_CONTENT_TYPE, [UPLOAD_OFFSET_HEADER]: String(transfer.uploaded) },
        signal,
        timeoutMs: 120_000,
      });
      transfer.uploaded = Number(response.headers.get(UPLOAD_OFFSET_HEADER) ?? end);
      transfer.attempts = 0;
      trackSpeed(transfer);
    }

    const done = await api<UploadCompleteResponse>(`/uploads/${transfer.uploadId}/complete`, { method: 'POST', signal, timeoutMs: 300_000 });
    transfer.state = 'done';
    // Sale del panel al instante. En la carpeta de destino sigue como «Guardado» hasta que el
    // listado muestra el archivo real o pasan 8 s; entonces se olvida del todo.
    setTimeout(() => {
      transfer.settled = true;
      drop(transfer.id);
    }, 8000);
    transfer.speed = 0;
    transfer.finalName = done.name === transfer.name ? null : done.name;
    lastCompletedDest.value = transfer.dest;
    completedTick.value += 1;
  } catch (error) {
    transfer.speed = 0;
    if (signal.aborted) {
      // Pausa o cancelación: el estado ya lo fijó quien abortó.
    } else if (error instanceof ApiError && error.code === 'OFFSET_MISMATCH' && typeof error.details['offset'] === 'number') {
      transfer.uploaded = error.details['offset'];
      transfer.state = 'queued';
    } else if (error instanceof ApiError && (error.code === 'STORAGE_UNAVAILABLE' || error.code === 'NETWORK' || error.code === 'TIMEOUT' || error.status >= 500 || error.retryable)) {
      transfer.state = 'waiting';
      transfer.messageText = '';
      transfer.messageKey =
        error.code === 'STORAGE_UNAVAILABLE'
          ? 'transfers.waitDisk'
          : error.code === 'NETWORK'
            ? 'transfers.waitNetwork'
            : error.code === 'TIMEOUT'
              ? 'transfers.waitTimeout'
              : 'transfers.waitBusy';
      scheduleRetry(transfer);
    } else if (error instanceof ApiError && error.code === 'NOT_FOUND' && transfer.uploadId !== null) {
      // La subida caducó o se perdió su temporal en el servidor: se empieza de nuevo.
      transfer.uploadId = null;
      transfer.uploaded = 0;
      transfer.state = 'queued';
    } else {
      transfer.state = 'error';
      transfer.messageKey = error instanceof Error ? '' : 'transfers.unknownError';
      transfer.messageText = error instanceof Error ? error.message : '';
    }
  } finally {
    controllers.delete(transfer.id);
    samples.delete(transfer.id);
    pump();
  }
}

function pump(): void {
  let running = transfers.value.filter((item) => item.state === 'uploading').length;
  while (running < MAX_PARALLEL) {
    const next = transfers.value.find((item) => item.state === 'queued');
    if (next === undefined) break;
    running += 1;
    void run(next);
  }
}

export function useTransfers() {
  const active = computed(() => transfers.value.filter((item) => item.state === 'uploading' || item.state === 'queued' || item.state === 'waiting'));
  const busy = computed(() => active.value.length > 0);
  /** Lo que se muestra en el panel: todo lo que no ha terminado (también en pausa o con error). */
  const pending = computed(() => transfers.value.filter((item) => item.state !== 'done' && item.state !== 'cancelled'));
  const totals = computed(() => {
    let size = 0;
    let uploaded = 0;
    let speed = 0;
    let uploading = 0;
    let failed = 0;
    for (const item of pending.value) {
      size += item.size;
      uploaded += item.uploaded;
      if (item.state === 'uploading') {
        speed += item.speed;
        uploading += 1;
      }
      if (item.state === 'error') failed += 1;
    }
    return { size, uploaded, speed, uploading, failed, percent: size === 0 ? 0 : Math.floor((uploaded / size) * 100) };
  });

  function enqueue(files: readonly File[], dest: string): void {
    for (const file of files) {
      transfers.value.push({
        id: nextId++,
        file: markRaw(file),
        name: file.name.normalize('NFC'),
        dest,
        size: file.size,
        uploaded: 0,
        state: 'queued',
        speed: 0,
        messageKey: '',
        messageText: '',
        get message(): string {
          return this.messageKey !== '' ? t(this.messageKey) : this.messageText;
        },
        finalName: null,
        settled: false,
        uploadId: null,
        chunkSize: 8 * 1024 * 1024,
        attempts: 0,
      });
    }
    pump();
  }

  function pause(id: number): void {
    const transfer = find(id);
    if (transfer === undefined || (transfer.state !== 'uploading' && transfer.state !== 'queued' && transfer.state !== 'waiting')) return;
    transfer.state = 'paused';
    transfer.messageKey = '';
    transfer.messageText = '';
    clearTimeout(retryTimers.get(id));
    controllers.get(id)?.abort();
  }

  function resume(id: number): void {
    const transfer = find(id);
    if (transfer === undefined || (transfer.state !== 'paused' && transfer.state !== 'error' && transfer.state !== 'waiting')) return;
    clearTimeout(retryTimers.get(id));
    transfer.state = 'queued';
    transfer.messageKey = '';
    transfer.messageText = '';
    pump();
  }

  function cancel(id: number): void {
    const transfer = find(id);
    if (transfer === undefined || transfer.state === 'done' || transfer.state === 'cancelled') return;
    transfer.state = 'cancelled';
    transfer.messageKey = '';
    transfer.messageText = '';
    clearTimeout(retryTimers.get(id));
    controllers.get(id)?.abort();
    if (transfer.uploadId !== null) {
      const uploadId = transfer.uploadId;
      // Si el servidor aún está recibiendo el último bloque (409), se reintenta poco después.
      const remove = (attempt: number): void => {
        api(`/uploads/${uploadId}`, { method: 'DELETE' }).catch((error: unknown) => {
          if (attempt < 3 && error instanceof ApiError && error.retryable) setTimeout(() => remove(attempt + 1), 1500 * (attempt + 1));
        });
      };
      remove(0);
    }
    drop(id);
  }

  /** Eliminar una subida desde la interfaz: siempre con confirmación (se descarta lo subido). */
  async function confirmCancel(transfer: Transfer): Promise<void> {
    const ok = await confirmDialog({
      title: t('transfers.cancelTitle'),
      message: t('transfers.cancelMessage', { name: transfer.name }),
      confirm: t('transfers.cancelConfirm'),
      danger: true,
    });
    if (ok) cancel(transfer.id);
  }

  /** Reintenta ya todo lo que estaba esperando al disco o a la red. */
  function resumeWaiting(): void {
    for (const transfer of transfers.value) {
      if (transfer.state === 'waiting') {
        clearTimeout(retryTimers.get(transfer.id));
        transfer.state = 'queued';
      }
    }
    pump();
  }

  function pauseAll(): void {
    for (const transfer of [...active.value]) pause(transfer.id);
  }

  function resumeAll(): void {
    for (const transfer of transfers.value) if (transfer.state === 'paused') resume(transfer.id);
  }

  function openPanel(): void {
    panelOpen.value = true;
  }

  return { transfers, active, busy, pending, totals, panelOpen, openPanel, completedTick, lastCompletedDest, enqueue, pause, resume, cancel, confirmCancel, resumeWaiting, pauseAll, resumeAll };
}
