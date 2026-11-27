<script setup lang="ts">
const { status } = useStorage();
const label = computed(() => volumeLabel(status.value));
const space = computed(() => status.value?.space ?? null);
const used = computed(() => (space.value === null ? 0 : space.value.totalBytes - space.value.freeBytes));
const percent = computed(() => (space.value === null || space.value.totalBytes === 0 ? 0 : Math.max(1, Math.round((used.value / space.value.totalBytes) * 100))));
const fsLabel = computed(() => {
  const type = status.value?.mount?.fsType;
  return type === 'exfat' ? 'exFAT' : type === 'ntfs3' || type === 'fuseblk' ? 'NTFS' : t('disk.usbDisk');
});
</script>

<template>
  <section :aria-label="t('disk.dataDisk')" class="disk" :class="`tone-${label.tone}`">
    <div class="head">
      <AppIcon name="drive" :size="20" class="muted" />
      <div class="names">
        <strong>{{ t('disk.dataDisk') }}</strong>
        <span class="muted">{{ fsLabel }}</span>
      </div>
    </div>
    <span class="state"><span class="dot" aria-hidden="true" />{{ label.widget }}</span>
    <template v-if="space">
      <div class="bar" aria-hidden="true"><span :style="{ width: `${percent}%` }" /></div>
      <div class="numbers muted">
        <span>{{ t('disk.used', { size: formatBytes(used) }) }}</span>
        <span>{{ t('disk.free', { size: formatBytes(space.freeBytes) }) }}</span>
      </div>
    </template>
  </section>
</template>

<style scoped>
.disk {
  margin-top: auto;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.names {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.names strong {
  font-size: 13px;
  font-weight: 600;
}

.names span,
.numbers {
  font-size: 12px;
}

.state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
}

.tone-ok .state {
  color: var(--ok);
}

.tone-warn .state {
  color: var(--warn);
}

.tone-danger .state {
  color: var(--danger);
}

.tone-danger {
  border-color: var(--danger-border);
  background: var(--danger-soft);
}

.tone-warn {
  border-color: var(--warn-border);
  background: var(--warn-soft);
}

.tone-muted .state {
  color: var(--muted);
}

.numbers {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
</style>
