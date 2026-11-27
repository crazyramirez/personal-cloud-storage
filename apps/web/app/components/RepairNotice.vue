<script setup lang="ts">
/**
 * Aviso de que el disco se reparó (o revisó) solo (ADR-0032), visible las 24 h siguientes hasta
 * que se cierra. Así se sabe que la nube no se ha quedado parada por nada y qué se hizo.
 */
const { status, state } = useStorage();
const KEY = 'pcloud.repair-notice-seen';

const seen = ref<string | null>(null);
onMounted(() => {
  try {
    seen.value = localStorage.getItem(KEY);
  } catch {
    seen.value = null;
  }
});

const repair = computed(() => status.value?.repair ?? null);
const visible = computed(() => {
  const r = repair.value;
  if (state.value !== 'READY' || r === null || r.phase !== 'done' || r.finishedAt === null) return false;
  if (seen.value === r.finishedAt) return false;
  return Date.now() - Date.parse(r.finishedAt) < 24 * 60 * 60 * 1000;
});
const time = computed(() => {
  const at = repair.value?.finishedAt;
  return at ? dateFormat({ hour: '2-digit', minute: '2-digit' }).format(new Date(at)) : '';
});
const message = computed(() => {
  const r = repair.value;
  if (r?.result === 'repaired') {
    return r.fixed !== null && r.fixed > 0 ? t('volume.repairDoneRepaired', { time: time.value, n: r.fixed }) : t('volume.repairDoneRepairedNoCount', { time: time.value });
  }
  return t('volume.repairDoneClean', { time: time.value });
});

function dismiss(): void {
  const at = repair.value?.finishedAt ?? null;
  seen.value = at;
  try {
    if (at !== null) localStorage.setItem(KEY, at);
  } catch {
    // Sin almacenamiento: se oculta hasta recargar.
  }
}
</script>

<template>
  <p v-if="visible" class="notice notice-ok" role="status">
    <AppIcon name="check" />
    <span class="text">{{ message }}</span>
    <button type="button" class="btn" @click="dismiss">{{ t('volume.repairDismiss') }}</button>
  </p>
</template>

<style scoped>
.notice-ok {
  align-items: center;
  background: var(--ok-soft);
  color: var(--ok);
}

.text {
  flex: 1;
  min-width: 0;
}
</style>
