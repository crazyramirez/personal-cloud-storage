<script setup lang="ts">
const props = defineProps<{ transfer: Transfer }>();
const { pause, resume, cancel, remove } = useTransfers();

function menu(): MenuItem[] {
  const item = props.transfer;
  const active = item.state === 'uploading' || item.state === 'queued' || item.state === 'waiting';
  const finished = item.state === 'done' || item.state === 'cancelled';
  const folder = item.dest.split('/').filter(Boolean);
  return [
    { label: t('transfers.pause'), icon: 'pause', disabled: !active, run: () => pause(item.id) },
    { label: item.state === 'error' ? t('common.retry') : t('transfers.resume'), icon: 'play', disabled: item.state !== 'paused' && item.state !== 'error' && item.state !== 'waiting', run: () => resume(item.id) },
    { label: t('transfers.openDestination'), icon: 'folder', separator: true, run: () => void navigateTo(explorerLink(folder)) },
    finished
      ? { label: t('transfers.removeFromList'), icon: 'close', separator: true, run: () => remove(item.id) }
      : { label: t('transfers.cancelUpload'), icon: 'close', danger: true, separator: true, run: () => cancel(item.id) },
  ];
}

const longPress = useLongPress((point) => openMenuFor(point, menu(), props.transfer.name));

const percent = computed(() => (props.transfer.size === 0 ? 100 : Math.min(100, Math.floor((props.transfer.uploaded / props.transfer.size) * 100))));

const chip = computed(() => {
  switch (props.transfer.state) {
    case 'uploading': return { label: t('transfers.stateUploading'), tone: 'accent' };
    case 'queued': return { label: t('transfers.stateQueued'), tone: 'muted' };
    case 'paused': return { label: t('transfers.statePaused'), tone: 'muted' };
    case 'waiting': return { label: t('transfers.stateWaiting'), tone: 'warn' };
    case 'error': return { label: t('transfers.stateError'), tone: 'danger' };
    case 'done': return { label: t('transfers.stateDone'), tone: 'ok' };
    default: return { label: t('transfers.stateCancelled'), tone: 'muted' };
  }
});

const meta = computed(() => {
  const item = props.transfer;
  if (item.state === 'done') {
    return item.finalName === null
      ? t('transfers.doneConfirmed', { size: formatBytes(item.size) })
      : t('transfers.doneRenamed', { size: formatBytes(item.size), name: item.finalName });
  }
  if (item.state === 'cancelled') return t('transfers.cancelledNothingSaved');
  if (item.message !== '') return item.message;
  const progress = t('transfers.progress', { done: formatBytes(item.uploaded), total: formatBytes(item.size) });
  if (item.state !== 'uploading' || item.speed <= 0) return progress;
  return [progress, formatSpeed(item.speed), formatRemaining((item.size - item.uploaded) / item.speed)].filter(Boolean).join(' · ');
});

const showBar = computed(() => ['uploading', 'queued', 'paused', 'waiting'].includes(props.transfer.state));
const canPause = computed(() => ['uploading', 'queued', 'waiting'].includes(props.transfer.state));
const canResume = computed(() => props.transfer.state === 'paused');
const canRetry = computed(() => props.transfer.state === 'error');
const canCancel = computed(() => !['done', 'cancelled'].includes(props.transfer.state));
</script>

<template>
  <li
    class="row"
    @contextmenu.prevent="openMenuFor($event, menu(), transfer.name)"
    @touchstart.passive="longPress.onTouchstart"
    @touchmove.passive="longPress.onTouchmove"
    @touchend="longPress.onTouchend"
  >
    <span class="direction" :class="`tone-${chip.tone}`"><AppIcon name="upload" :size="20" :stroke="1.9" /></span>
    <div class="body">
      <div class="title">
        <strong>{{ transfer.name }}</strong>
        <span class="muted route">→ {{ transfer.dest === '/' ? t('common.files') : transfer.dest.slice(1) }}</span>
        <span class="chip" :class="`chip-${chip.tone}`">{{ chip.label }}</span>
      </div>
      <div v-if="showBar" class="bar" aria-hidden="true"><span :class="{ idle: transfer.state !== 'uploading' }" :style="{ width: `${percent}%` }" /></div>
      <span class="meta" :class="{ muted: transfer.state !== 'error' && transfer.state !== 'waiting' }">{{ meta }}</span>
    </div>
    <div class="actions">
      <button v-if="canPause" type="button" class="btn btn-icon" :aria-label="t('transfers.pauseNamed', { name: transfer.name })" @click="pause(transfer.id)"><AppIcon name="pause" :stroke="1.9" /></button>
      <button v-if="canResume" type="button" class="btn btn-icon" :aria-label="t('transfers.resumeNamed', { name: transfer.name })" @click="resume(transfer.id)"><AppIcon name="play" :stroke="1.9" /></button>
      <button v-if="canRetry" type="button" class="btn" @click="resume(transfer.id)"><AppIcon name="refresh" :stroke="1.9" />{{ t('common.retry') }}</button>
      <button v-if="canCancel" type="button" class="btn btn-icon btn-ghost muted" :aria-label="t('transfers.cancelNamed', { name: transfer.name })" @click="cancel(transfer.id)"><AppIcon name="close" :stroke="1.9" /></button>
    </div>
  </li>
</template>

<style scoped>
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--surface);
}

.direction {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--accent);
}

.direction.tone-ok {
  color: var(--ok);
}

.direction.tone-warn {
  color: var(--warn);
}

.direction.tone-danger {
  color: var(--danger);
}

.direction.tone-muted {
  color: var(--muted);
}

.body {
  flex: 1 1 320px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}

.title strong {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.route {
  font-size: 12px;
}

.meta {
  font-size: 13px;
}

.bar > span.idle {
  background: var(--border-strong);
}

.actions {
  display: flex;
  gap: 6px;
}
</style>
