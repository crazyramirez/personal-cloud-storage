<script setup lang="ts">
/**
 * Medidor circular de UN valor frente a su límite (uso de CPU, memoria, disco, temperatura).
 * Arco de 270° con la abertura abajo; el relleno lleva la gravedad (normal → aviso → peligro) y la
 * pista es un tono suave de ese mismo color. El texto del centro va siempre en tinta de texto,
 * nunca en el color del dato. No es un gráfico de partes (eso sería una barra segmentada).
 */
const props = withDefaults(
  defineProps<{
    /** 0-1; null = sin dato (pista vacía). */
    value: number | null;
    /** Texto grande del centro (p. ej. «37 %», «52 °C»). */
    display: string;
    /** Línea pequeña bajo el valor. */
    caption?: string;
    /** Nombre accesible completo («Uso de la CPU: 37 %»). */
    label: string;
    tone?: 'accent' | 'ok' | 'warn' | 'danger';
    size?: number;
    stroke?: number;
  }>(),
  { caption: '', tone: 'accent', size: 132, stroke: 10 },
);

const SWEEP = 270;
const radius = computed(() => (props.size - props.stroke) / 2);
const center = computed(() => props.size / 2);
const length = computed(() => 2 * Math.PI * radius.value * (SWEEP / 360));
const circumference = computed(() => 2 * Math.PI * radius.value);
const filled = computed(() => length.value * Math.min(1, Math.max(0, props.value ?? 0)));
/** El arco empieza abajo a la izquierda (135°) y gira en sentido horario. */
const rotate = computed(() => `rotate(135 ${center.value} ${center.value})`);
const percent = computed(() => (props.value === null ? undefined : Math.round(Math.min(1, Math.max(0, props.value)) * 100)));
</script>

<template>
  <div class="meter" :class="`tone-${tone}`" role="meter" :aria-label="label" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="percent" :aria-valuetext="`${display}${caption ? `, ${caption}` : ''}`" :style="{ width: `${size}px`, height: `${size}px` }">
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" aria-hidden="true">
      <circle
        class="track"
        :cx="center"
        :cy="center"
        :r="radius"
        fill="none"
        :stroke-width="stroke"
        stroke-linecap="round"
        :stroke-dasharray="`${length} ${circumference}`"
        :transform="rotate"
      />
      <circle
        v-if="value !== null && filled > 0.5"
        class="fill"
        :cx="center"
        :cy="center"
        :r="radius"
        fill="none"
        :stroke-width="stroke"
        stroke-linecap="round"
        :stroke-dasharray="`${filled} ${circumference}`"
        :transform="rotate"
      />
    </svg>
    <div class="center" aria-hidden="true">
      <strong :style="{ fontSize: `${Math.round(size * (caption ? 0.2 : 0.22))}px` }">{{ display }}</strong>
      <span v-if="caption">{{ caption }}</span>
    </div>
  </div>
</template>

<style scoped>
.meter {
  position: relative;
  flex: none;
}

.track {
  stroke: var(--meter-track);
}

.fill {
  stroke: var(--meter-fill);
  transition: stroke-dasharray 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.tone-accent {
  --meter-fill: var(--accent-btn);
  --meter-track: var(--accent-soft);
}

.tone-ok {
  --meter-fill: var(--ok);
  --meter-track: var(--ok-soft);
}

.tone-warn {
  --meter-fill: var(--warn);
  --meter-track: var(--warn-soft);
}

.tone-danger {
  --meter-fill: var(--danger);
  --meter-track: var(--danger-soft);
}

.center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding-bottom: 4%;
  text-align: center;
}

.center strong {
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1;
  color: var(--text);
}

.center span {
  font-size: 12px;
  color: var(--muted);
  max-width: 70%;
  line-height: 1.2;
}

@media (prefers-reduced-motion: reduce) {
  .fill {
    transition: none;
  }
}
</style>
