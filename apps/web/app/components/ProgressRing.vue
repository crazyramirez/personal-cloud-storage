<script setup lang="ts">
/** Anillo de progreso (o giratorio indeterminado si `value` es null). */
const props = withDefaults(defineProps<{ value: number | null; size?: number; stroke?: number; tone?: 'accent' | 'warn' | 'danger' | 'muted' | 'ok' }>(), {
  size: 28,
  stroke: 3,
  tone: 'accent',
});
const radius = computed(() => (props.size - props.stroke) / 2);
const circumference = computed(() => 2 * Math.PI * radius.value);
const offset = computed(() => circumference.value * (1 - Math.min(1, Math.max(0, props.value ?? 0.25))));
</script>

<template>
  <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" class="ring" :class="[`tone-${tone}`, { spin: value === null }]" aria-hidden="true">
    <circle class="track" :cx="size / 2" :cy="size / 2" :r="radius" :stroke-width="stroke" fill="none" />
    <circle
      class="bar"
      :cx="size / 2"
      :cy="size / 2"
      :r="radius"
      :stroke-width="stroke"
      fill="none"
      stroke-linecap="round"
      :stroke-dasharray="circumference"
      :stroke-dashoffset="offset"
      :transform="`rotate(-90 ${size / 2} ${size / 2})`"
    />
  </svg>
</template>

<style scoped>
.ring {
  flex: none;
}

.track {
  stroke: var(--track);
}

.bar {
  stroke: var(--accent-btn);
  transition: stroke-dashoffset 0.35s ease;
}

.tone-warn .bar {
  stroke: var(--warn);
}

.tone-danger .bar {
  stroke: var(--danger);
}

.tone-ok .bar {
  stroke: var(--ok);
}

.tone-muted .bar {
  stroke: var(--muted);
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
