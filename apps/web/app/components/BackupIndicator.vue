<script setup lang="ts">
/**
 * Copia de seguridad, a nivel de toda la app (solo propietario):
 *  - en la cabecera, un icono con el progreso mientras copia (lleva a Ajustes);
 *  - al conectar el disco de copia, pregunta si sincronizar (salvo «sincronizar automáticamente»);
 *  - al conectar otro disco, ofrece asignarlo (o avisa de que no es el de copia);
 *  - si hay muchos borrados, pide confirmación; al terminar, avisa de que se puede desconectar.
 * Cada disco se pregunta una vez por conexión (se recuerda en este navegador).
 */
import type { BackupDiskView, BackupStatusResponse } from '@pcloud/contracts';

const session = useSession();
const isOwner = computed(() => session.user.value?.role === 'owner');
const backup = useBackup();
const { status, busy } = backup;

const ASKED_KEY = 'pcloud.backup.asked';
function loadAsked(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(ASKED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
const asked = loadAsked();
function markAsked(key: string): void {
  asked.add(key);
  try {
    localStorage.setItem(ASKED_KEY, JSON.stringify([...asked].slice(-50)));
  } catch {
    // Sin almacenamiento: se recuerda solo en esta pestaña.
  }
}

const percent = computed(() => {
  const progress = status.value?.progress;
  if (progress === null || progress === undefined || progress.bytesTotal === 0) return null;
  return progress.bytesDone / progress.bytesTotal;
});
const label = computed(() => {
  const phase = status.value?.phase ?? 'idle';
  const pct = percent.value === null ? '' : ` · ${Math.floor(percent.value * 100)}%`;
  return `${t('backup.inProgress')}: ${t(`backup.phase_${phase}`)}${pct}`;
});

let asking = false;
let lastRunSeen: number | null | undefined;
let confirmShownFor: string | null = null;

async function askSync(never: boolean): Promise<void> {
  const ok = await confirmDialog({
    title: t('backup.promptSyncTitle'),
    message: never ? t('backup.promptSyncNever') : t('backup.promptSyncMessage', { days: status.value?.retentionDays ?? 90 }),
    confirm: t('backup.syncNow'),
  });
  if (ok) await backup.sync().catch((error: unknown) => toast(errorMessage(error), { tone: 'danger' }));
}

async function offerAssign(disk: BackupDiskView, current: BackupStatusResponse): Promise<void> {
  const replacing = current.assigned !== null;
  const ok = await confirmDialog({
    title: replacing ? t('backup.promptOtherTitle') : t('backup.promptNewTitle'),
    message: replacing
      ? t('backup.promptOtherMessage', { name: diskName(disk), assigned: diskName(current.assigned!) })
      : t('backup.promptNewMessage', { name: diskName(disk) }),
    confirm: replacing ? t('backup.replaceBackup') : t('backup.useAsBackup'),
  });
  if (!ok) return;
  try {
    await backup.assign(disk);
    toast(t('backup.assigned'), { tone: 'ok' });
    await askSync(true);
  } catch (error) {
    toast(errorMessage(error), { tone: 'danger' });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? serverText(error.message) : String(error);
}

async function react(current: BackupStatusResponse): Promise<void> {
  // Resultado de una copia recién terminada.
  const last = current.lastRun;
  if (lastRunSeen === undefined) lastRunSeen = last?.id ?? null;
  else if (last !== null && last.id !== lastRunSeen && last.result !== 'running') {
    lastRunSeen = last.id;
    if (last.result === 'ok') toast(t('backup.doneToast'), { tone: 'ok', timeoutMs: 10_000 });
    else if (last.result === 'ok_with_errors') toast(t('backup.doneWithErrorsToast', { n: last.failedFiles }), { tone: 'warn', timeoutMs: 12_000 });
    else if (last.result === 'failed') toast(t('backup.failedToast', { reason: backupProblemText(last.error) }), { tone: 'danger', timeoutMs: 12_000 });
  }

  if (asking) return;
  asking = true;
  try {
    // Confirmación de borrados (o nube vacía) pedida por el servidor.
    if (current.phase === 'confirm' && current.pendingPlan !== null) {
      const key = `${current.lastRun?.id ?? 0}`;
      if (confirmShownFor === key) return;
      confirmShownFor = key;
      const ok = await confirmDialog({
        title: t('backup.confirmTitle'),
        message: current.problem === 'SOURCE_EMPTY' ? t('backup.confirmEmpty') : t('backup.confirmRemoved', { n: current.pendingPlan.removedFiles, days: current.retentionDays }),
        confirm: t('backup.confirmGo'),
        danger: true,
      });
      await (ok ? backup.sync(true) : backup.cancel()).catch(() => undefined);
      return;
    }
    if (current.phase !== 'idle' || !current.agentReady) return;

    for (const disk of current.disks) {
      const key = `${disk.uuid}@${disk.connectedAt}`;
      if (asked.has(key)) continue;
      markAsked(key);
      if (disk.assigned) {
        // Ya sincronizado desde que se conectó (o empieza solo): no se pregunta.
        const syncedSince = current.lastRun !== null && current.lastRun.startedAt >= disk.connectedAt;
        if (!current.autoSync && !syncedSince) await askSync(current.lastSuccessAt === null);
      } else if (!disk.compatible) {
        toast(t('backup.promptIncompatible', { name: diskName(disk), fs: fsName(disk.fsType) }), { tone: 'warn', timeoutMs: 10_000 });
      } else {
        await offerAssign(disk, current);
      }
      return;
    }
  } finally {
    asking = false;
  }
}

watch(status, (current) => {
  if (current !== null && isOwner.value) void react(current);
});

onMounted(() => {
  if (isOwner.value) backup.start();
});
watch(isOwner, (owner, before) => {
  if (owner && !before) backup.start();
  if (!owner && before) backup.stop();
});
onBeforeUnmount(() => {
  if (isOwner.value) backup.stop();
});
</script>

<template>
  <NuxtLink v-if="isOwner && busy" to="/ajustes#copia" class="btn btn-icon backup" :aria-label="label" :title="label">
    <ProgressRing class="ring" :value="percent" :size="38" :stroke="2.5" />
    <AppIcon name="backup" />
  </NuxtLink>
</template>

<style scoped>
.backup {
  position: relative;
  color: var(--accent);
}

.backup .ring {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
</style>
