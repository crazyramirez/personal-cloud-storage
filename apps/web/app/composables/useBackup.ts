import type { BackupDiskView, BackupStatusResponse } from '@pcloud/contracts';

/**
 * Estado de la copia de seguridad en disco externo (ADR-0017), compartido por el aviso global y
 * Ajustes. Solo para el propietario. Se sondea cada 5 s (cada segundo mientras copia) con la
 * pestaña visible.
 */
const status = ref<BackupStatusResponse | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;
let consumers = 0;

const busyPhases = new Set(['mounting', 'scanning', 'copying', 'finishing', 'ejecting']);

async function refresh(): Promise<void> {
  try {
    status.value = await api<BackupStatusResponse>('/backup');
  } catch {
    // Sin conexión o sin permiso: se conserva lo último conocido.
  }
}

function schedule(): void {
  if (consumers === 0) return;
  const fast = status.value !== null && busyPhases.has(status.value.phase);
  timer = setTimeout(async () => {
    if (document.visibilityState === 'visible') await refresh();
    schedule();
  }, fast ? 1000 : 5000);
}

/** Nombre legible de un disco: etiqueta, modelo y tamaño. */
export function diskName(disk: { label: string | null; model: string | null; sizeBytes: number }): string {
  const name = disk.label ?? disk.model ?? t('backup.assignedDisk');
  const extra = [disk.label !== null ? disk.model : null, formatBytes(disk.sizeBytes)].filter(Boolean).join(', ');
  return `«${name}» (${extra})`;
}

/** Nombre habitual del sistema de archivos (lsblk dice «vfat» para FAT32). */
export function fsName(fsType: string): string {
  const names: Record<string, string> = { vfat: 'FAT32', exfat: 'exFAT', ntfs: 'NTFS', ext4: 'ext4', hfsplus: 'HFS+', apfs: 'APFS', btrfs: 'Btrfs' };
  return names[fsType] ?? fsType.toUpperCase();
}

export function backupProblemText(code: string | null): string {
  if (code === null) return '';
  const key = `backup.problem_${code}`;
  const text = t(key);
  return text === key ? t('backup.problem_unknown', { code }) : text;
}

export function useBackup() {
  const busy = computed(() => status.value !== null && busyPhases.has(status.value.phase));

  function start(): void {
    consumers += 1;
    if (consumers === 1) {
      void refresh();
      schedule();
    }
  }

  function stop(): void {
    consumers = Math.max(0, consumers - 1);
    if (consumers === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function call(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<void> {
    status.value = await api<BackupStatusResponse>(path, { method, body: body ?? {} });
    if (timer !== null) clearTimeout(timer);
    schedule();
  }

  return {
    status,
    busy,
    refresh,
    start,
    stop,
    assign: (disk: BackupDiskView) => call('/backup/assign', 'POST', { uuid: disk.uuid }),
    unassign: () => call('/backup/assign', 'DELETE'),
    sync: (confirm = false) => call('/backup/start', 'POST', { confirm }),
    cancel: () => call('/backup/cancel', 'POST'),
    eject: () => call('/backup/eject', 'POST'),
    settings: (patch: { autoSync?: boolean; retentionDays?: number }) => call('/backup/settings', 'PATCH', patch),
  };
}
