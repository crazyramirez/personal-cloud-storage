<script setup lang="ts">
const { state, unreachable } = useStorage();
const view = computed(() =>
  unreachable.value ? { pill: t('volume.noServer'), tone: 'danger' as Tone } : VOLUME_LABELS[state.value],
);
</script>

<template>
  <p role="status" class="chip pill" :class="`chip-${view.tone}`" :title="t('volume.pillTitle', { state })">
    <span class="dot" aria-hidden="true" />{{ view.pill }}
  </p>
</template>

<style scoped>
.pill {
  min-height: 32px;
  padding: 0 12px;
  font-size: 13px;
  gap: 8px;
}
</style>
