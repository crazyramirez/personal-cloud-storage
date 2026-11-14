<script setup lang="ts">
/** Ajustes → Copia de seguridad (ADR-0017). Solo propietario. */
import type { BackupDiskView, BackupRunView } from '@pcloud/contracts';

const backup = useBackup();
const { status, busy } = backup;
const working = ref(false);

onMounted(() => {
  backup.start();
  // Enlace directo (/ajustes#copia, p. ej. desde el icono de la cabecera): la sección se pinta
  // después de que el router intente desplazarse, así que se hace aquí.
  if (useRoute().hash === '#copia') void nextTick(() => document.getElementById('copia')?.scrollIntoView({ block: 'start' }));
});
onBeforeUnmount(() => backup.stop());

const assignedDisk = computed(() => status.value?.disks.find((disk) => disk.assigned) ?? null);
const others = computed(() => status.value?.disks.filter((disk) => !disk.assigned) ?? []);
const progress = computed(() => status.value?.progress ?? null);
const percent = computed(() => {
  const p = progress.value;
  return p === null || p.bytesTotal === 0 ? 0 : Math.min(100, Math.floor((p.bytesDone / p.bytesTotal) * 100));
});
const remaining = computed(() => {
  const p = progress.value;
  if (p === null || p.bytesPerSecond <= 0) return '';
  return t('backup.remaining', { time: formatRemaining((p.bytesTotal - p.bytesDone) / p.bytesPerSecond) });
});
const RETENTION = [30, 90, 180, 365];
const history = ref<BackupRunView[]>([]);

async function loadHistory(): Promise<void> {
  try {
    history.value = (await api<{ runs: BackupRunView[] }>('/backup/history')).runs;
  } catch {
    history.value = [];
  }
}
onMounted(loadHistory);
watch(() => status.value?.lastRun?.id, () => void loadHistory());
watch(() => status.value?.lastRun?.result, () => void loadHistory());

async function run(action: () => Promise<void>, done?: string): Promise<void> {
  working.value = true;
  try {
    await action();
    if (done !== undefined) toast(done, { tone: 'ok' });
  } catch (error) {
    toast(error instanceof ApiError ? serverText(error.message) : String(error), { tone: 'danger' });
  } finally {
    working.value = false;
  }
}

async function assign(disk: BackupDiskView): Promise<void> {
  const ok = await confirmDialog({ title: t('backup.assignTitle'), message: t('backup.assignMessage', { name: diskName(disk) }), confirm: t('backup.assignConfirm') });
  if (ok) await run(() => backup.assign(disk), t('backup.assigned'));
}

async function unassign(): Promise<void> {
  const ok = await confirmDialog({ title: t('backup.unassignTitle'), message: t('backup.unassignMessage'), confirm: t('backup.unassignConfirm') });
  if (ok) await run(() => backup.unassign());
}

function resultTone(run: BackupRunView): string {
  return run.result === 'ok' ? 'ok' : run.result === 'ok_with_errors' ? 'warn' : run.result === 'failed' ? 'danger' : 'muted';
}

function summaryLine(run: BackupRunView): string {
  return t('backup.summaryLine', {
    new: run.summary.newFiles,
    changed: run.summary.changedFiles,
    removed: run.summary.removedFiles,
    copied: formatBytes(run.bytesCopied),
  });
}
</script>

<template>
  <section id="copia" class="card sec" aria-labelledby="s-backup">
    <header><AppIcon name="backup" /><h2 id="s-backup">{{ t('backup.title') }}</h2></header>
    <p class="muted">{{ t('backup.intro') }}</p>

    <template v-if="status">
      <p v-if="!status.agentReady" role="alert" class="notice notice-warn">{{ t('backup.problem_AGENT_UNAVAILABLE') }}</p>

      <!-- Disco asignado -->
      <div v-if="status.assigned" class="disk">
        <span class="disk-ico" :class="{ on: status.assignedConnected }"><AppIcon name="drive" :size="22" /></span>
        <div class="grow">
          <strong>{{ status.assigned.label ?? status.assigned.model ?? t('backup.assignedDisk') }}</strong>
          <span class="muted small">{{ [status.assigned.model, formatBytes(status.assigned.sizeBytes)].filter(Boolean).join(' · ') }}</span>
          <span class="muted small">{{ t('backup.lastBackup') }}: {{ status.lastSuccessAt ? formatRelative(status.lastSuccessAt) : t('backup.never') }}</span>
        </div>
        <span class="chip" :class="status.assignedConnected ? 'chip-ok' : 'chip-muted'">{{ status.assignedConnected ? t('backup.connected') : t('backup.notConnected') }}</span>
      </div>
      <p v-else class="notice notice-info">{{ t('backup.noAssigned') }}</p>

      <!-- Progreso -->
      <div v-if="busy || status.phase === 'confirm'" class="progress" aria-live="polite">
        <div class="line-top">
          <strong>{{ t(`backup.phase_${status.phase}`) }}</strong>
          <span v-if="progress && status.phase === 'copying'" class="mono muted">{{ percent }}%</span>
        </div>
        <div class="bar" aria-hidden="true"><span :class="{ indeterminate: status.phase !== 'copying' }" :style="{ width: status.phase === 'copying' ? `${percent}%` : '35%' }" /></div>
        <span v-if="progress && status.phase === 'copying'" class="muted small">
          {{ t('backup.progressFiles', { done: progress.filesDone, total: progress.filesTotal }) }} ·
          {{ t('backup.progressBytes', { done: formatBytes(progress.bytesDone), total: formatBytes(progress.bytesTotal) }) }}<template v-if="progress.bytesPerSecond > 0"> · {{ formatSpeed(progress.bytesPerSecond) }} · {{ remaining }}</template>
        </span>
        <span v-if="progress?.current" class="muted small current">{{ t('backup.copyingNow', { name: progress.current }) }}</span>
      </div>

      <p v-if="status.problem && !busy && status.phase !== 'confirm'" role="alert" class="notice notice-danger">{{ backupProblemText(status.problem) }}</p>

      <div v-if="status.assigned" class="actions">
        <button v-if="busy || status.phase === 'confirm'" type="button" class="btn" :disabled="working || status.phase === 'ejecting'" @click="run(() => backup.cancel())">
          <AppIcon name="close" />{{ t('backup.cancel') }}
        </button>
        <button v-else type="button" class="btn btn-primary" :disabled="working || !status.assignedConnected || !status.agentReady" :title="status.assignedConnected ? undefined : t('backup.syncNeedsDisk')" @click="run(() => backup.sync())">
          <AppIcon name="refresh" />{{ t('backup.syncNow') }}
        </button>
        <span v-if="!status.assignedConnected && !busy" class="muted small">{{ t('backup.syncNeedsDisk') }}</span>
      </div>

      <!-- Otros discos conectados -->
      <div v-if="others.length > 0" class="block">
        <h3>{{ t('backup.connectedDisks') }}</h3>
        <ul class="rows">
          <li v-for="disk in others" :key="disk.uuid" class="line">
            <AppIcon name="drive" class="muted" />
            <span class="grow">
              <strong>{{ disk.label ?? disk.model ?? disk.uuid }}</strong>
              <span class="muted small">{{ [disk.model, formatBytes(disk.sizeBytes), fsName(disk.fsType)].filter(Boolean).join(' · ') }}</span>
              <span v-if="!disk.compatible" class="small warn-text">{{ t('backup.incompatible', { fs: fsName(disk.fsType) }) }}</span>
            </span>
            <button v-if="disk.compatible" type="button" class="btn" :disabled="working || busy" @click="assign(disk)">
              {{ status.assigned ? t('backup.replaceBackup') : t('backup.useAsBackup') }}
            </button>
          </li>
        </ul>
      </div>
      <p v-else-if="!status.assigned" class="muted small">{{ t('backup.noDisks') }}</p>

      <!-- Preferencias -->
      <div v-if="status.assigned" class="block prefs">
        <label class="check-line">
          <input type="checkbox" :checked="status.autoSync" :disabled="working" @change="run(() => backup.settings({ autoSync: ($event.target as HTMLInputElement).checked }))">
          <span><strong>{{ t('backup.autoSync') }}</strong><br><span class="muted small">{{ t('backup.autoSyncHint') }}</span></span>
        </label>
        <label class="field">
          <span>{{ t('backup.retention') }}</span>
          <select class="input" :value="status.retentionDays" :disabled="working" @change="run(() => backup.settings({ retentionDays: Number(($event.target as HTMLSelectElement).value) }))">
            <option v-for="days in RETENTION.includes(status.retentionDays) ? RETENTION : [...RETENTION, status.retentionDays]" :key="days" :value="days">{{ t('backup.retentionDays', { n: days }) }}</option>
          </select>
        </label>
      </div>

      <!-- Historial -->
      <div v-if="status.assigned" class="block">
        <h3>{{ t('backup.history') }}</h3>
        <ul v-if="history.length > 0" class="rows">
          <li v-for="item in history.slice(0, 8)" :key="item.id" class="line">
            <span class="grow">
              <strong>{{ formatDate(item.startedAt) }}</strong>
              <span class="muted small">{{ summaryLine(item) }}<template v-if="item.failedFiles > 0"> · {{ item.failedFiles }} ✕</template></span>
              <span v-if="item.result === 'failed'" class="small danger-text">{{ backupProblemText(item.error) }}</span>
            </span>
            <span class="chip" :class="`chip-${resultTone(item)}`">{{ t(`backup.result_${item.result}`) }}</span>
          </li>
        </ul>
        <p v-else class="muted small">{{ t('backup.noHistory') }}</p>
      </div>

      <details class="how">
        <summary>{{ t('backup.howTitle') }}</summary>
        <ul class="muted">
          <li>{{ t('backup.how1') }}</li>
          <li>{{ t('backup.how2') }}</li>
          <li>{{ t('backup.how3') }}</li>
          <li>{{ t('backup.how4') }}</li>
          <li>{{ t('backup.powerHint') }}</li>
        </ul>
      </details>

      <div v-if="status.assigned && !busy" class="end">
        <button type="button" class="btn btn-ghost muted" :disabled="working" @click="unassign">{{ t('backup.unassign') }}</button>
      </div>
    </template>
    <p v-else class="muted">{{ t('common.loading') }}</p>
  </section>
</template>

<style scoped>
.sec {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  scroll-margin-top: 80px;
}

.sec header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sec h2 {
  font-size: 17px;
  font-weight: 650;
}

h3 {
  font-size: 14px;
  font-weight: 650;
}

.disk {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border-radius: 12px;
  background: var(--surface-2);
}

.disk-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: 12px;
  background: var(--surface);
  color: var(--muted);
}

.disk-ico.on {
  color: var(--ok);
}

.grow {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.grow strong {
  overflow-wrap: anywhere;
}

.small {
  font-size: 12px;
}

.progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.line-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.bar {
  height: 8px;
}

.bar > span.indeterminate {
  animation: slide 1.2s ease-in-out infinite alternate;
}

@keyframes slide {
  from {
    margin-left: 0;
  }

  to {
    margin-left: 65%;
  }
}

.current {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rows {
  display: flex;
  flex-direction: column;
}

.line {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
}

.prefs {
  gap: 14px;
}

.check-line {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 14px;
}

.check-line input {
  margin-top: 3px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 260px;
  font-size: 13px;
  font-weight: 500;
}

.how summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
}

.how ul {
  list-style: disc;
  padding-left: 18px;
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.end {
  display: flex;
  justify-content: flex-end;
}

.warn-text {
  color: var(--warn);
}

.danger-text {
  color: var(--danger);
}

@media (prefers-reduced-motion: reduce) {
  .bar > span.indeterminate {
    animation: none;
  }
}
</style>
