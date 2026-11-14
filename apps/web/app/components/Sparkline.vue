<script setup lang="ts">
/**
 * Evolución reciente de UN valor (una sola serie: el título de la tarjeta la nombra; sin leyenda).
 * Línea de 2 px, relleno muy suave, punto final con anillo del color de la superficie y una
 * línea base fina. Al pasar el ratón o el dedo (o con ← → si tiene el foco), una guía vertical
 * busca la muestra más cercana y un globo enseña su valor y su hora.
 */
const props = withDefaults(
  defineProps<{
    values: ReadonlyArray<number | null>;
    /** Instantes (ms) de cada muestra. */
    at: readonly number[];
    /** Escala vertical fija (si no se da, se ajusta a los datos). */
    min?: number;
    max?: number;
    format: (value: number) => string;
    /** Nombre accesible («Uso de la CPU, últimos 15 minutos»). */
    label: string;
    tone?: 'accent' | 'ok' | 'warn' | 'danger';
    height?: number;
  }>(),
  { min: undefined, max: undefined, tone: 'accent', height: 56 },
);

const box = ref<HTMLElement | null>(null);
const width = ref(0);
let observer: ResizeObserver | null = null;
onMounted(() => {
  if (box.value === null) return;
  width.value = box.value.clientWidth;
  observer = new ResizeObserver(([entry]) => {
    width.value = Math.round(entry?.contentRect.width ?? 0);
  });
  observer.observe(box.value);
});
onBeforeUnmount(() => observer?.disconnect());

const PAD_TOP = 6;
const PAD_BOTTOM = 3;
/** Margen derecho para que el punto final (r 4 + anillo 2) no se corte. */
const PAD_RIGHT = 7;

const domain = computed(() => {
  const present = props.values.filter((value): value is number => value !== null);
  let low = props.min ?? Math.min(...present, 0);
  let high = props.max ?? Math.max(...present, 1);
  if (props.max === undefined) high *= 1.15;
  if (high - low < 1e-9) high = low + 1;
  if (props.min === undefined && low > 0) low = 0;
  return { low, high };
});

const points = computed(() => {
  const count = props.values.length;
  const usable = Math.max(1, width.value - PAD_RIGHT);
  const { low, high } = domain.value;
  const span = props.height - PAD_TOP - PAD_BOTTOM;
  return props.values.map((value, index) => ({
    x: count <= 1 ? usable : (index / (count - 1)) * usable,
    y: value === null ? null : PAD_TOP + span - ((Math.min(high, Math.max(low, value)) - low) / (high - low)) * span,
    value,
  }));
});

/** Tramos continuos (un hueco sin dato corta la línea en vez de inventar valores). */
const segments = computed(() => {
  const out: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  for (const point of points.value) {
    if (point.y === null) {
      if (current.length > 0) out.push(current);
      current = [];
    } else {
      current.push({ x: point.x, y: point.y });
    }
  }
  if (current.length > 0) out.push(current);
  return out;
});

const linePath = computed(() => segments.value.map((seg) => seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('')).join(''));
const areaPath = computed(() => {
  const base = props.height - PAD_BOTTOM;
  return segments.value
    .filter((seg) => seg.length > 1)
    .map((seg) => `M${seg[0]!.x.toFixed(1)},${base}${seg.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('')}L${seg[seg.length - 1]!.x.toFixed(1)},${base}Z`)
    .join('');
});
const last = computed(() => [...points.value].reverse().find((point) => point.y !== null) ?? null);

// ── Interacción ──────────────────────────────────────────────────────────────────────────
const active = ref<number | null>(null);
const hovered = computed(() => (active.value === null ? null : points.value[active.value] ?? null));

function nearest(clientX: number): void {
  const rect = box.value?.getBoundingClientRect();
  const count = props.values.length;
  if (rect === undefined || count === 0) return;
  const usable = Math.max(1, rect.width - PAD_RIGHT);
  active.value = Math.min(count - 1, Math.max(0, Math.round(((clientX - rect.left) / usable) * (count - 1))));
}

function onKey(event: KeyboardEvent): void {
  const count = props.values.length;
  if (count === 0) return;
  if (event.key === 'ArrowLeft') active.value = Math.max(0, (active.value ?? count - 1) - 1);
  else if (event.key === 'ArrowRight') active.value = Math.min(count - 1, (active.value ?? count - 1) + 1);
  else if (event.key === 'Home') active.value = 0;
  else if (event.key === 'End') active.value = count - 1;
  else if (event.key === 'Escape') active.value = null;
  else return;
  event.preventDefault();
}

const timeFormat = computed(() => new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
const tooltip = computed(() => {
  const point = hovered.value;
  if (point === null || active.value === null) return null;
  const at = props.at[active.value];
  return { value: point.value === null ? '—' : props.format(point.value), time: at === undefined ? '' : timeFormat.value.format(at) };
});
const tooltipLeft = computed(() => {
  const point = hovered.value;
  if (point === null) return 0;
  return Math.min(Math.max(point.x, 44), Math.max(44, width.value - 44));
});

const summary = computed(() => {
  const present = props.values.filter((value): value is number => value !== null);
  if (present.length === 0) return props.label;
  return `${props.label}: ${t('system.chartSummary', { min: props.format(Math.min(...present)), max: props.format(Math.max(...present)), now: props.format(present[present.length - 1] as number) })}`;
});
</script>

<template>
  <div
    ref="box"
    class="spark"
    :class="`tone-${tone}`"
    :style="{ height: `${height}px` }"
    tabindex="0"
    role="img"
    :aria-label="summary"
    @pointermove="nearest($event.clientX)"
    @pointerdown="nearest($event.clientX)"
    @pointerleave="active = null"
    @blur="active = null"
    @keydown="onKey"
  >
    <svg v-if="width > 0" :width="width" :height="height" aria-hidden="true">
      <line class="base" x1="0" :x2="width" :y1="height - PAD_BOTTOM + 0.5" :y2="height - PAD_BOTTOM + 0.5" />
      <path class="area" :d="areaPath" />
      <path class="line" :d="linePath" />
      <line v-if="hovered" class="cross" :x1="hovered.x" :x2="hovered.x" y1="0" :y2="height" />
      <circle v-if="hovered && hovered.y !== null" class="dot" :cx="hovered.x" :cy="hovered.y" r="4" />
      <circle v-else-if="last && !hovered" class="dot" :cx="last.x" :cy="last.y!" r="4" />
    </svg>
    <div v-if="tooltip" class="tip" :style="{ left: `${tooltipLeft}px` }" aria-hidden="true">
      <strong>{{ tooltip.value }}</strong>
      <span>{{ tooltip.time }}</span>
    </div>
  </div>
</template>

<style scoped>
.spark {
  position: relative;
  width: 100%;
  touch-action: pan-y;
  cursor: crosshair;
  border-radius: 6px;
}

.spark:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

svg {
  display: block;
  overflow: visible;
}

.tone-accent {
  --spark: var(--accent-btn);
}

.tone-ok {
  --spark: var(--ok);
}

.tone-warn {
  --spark: var(--warn);
}

.tone-danger {
  --spark: var(--danger);
}

.base {
  stroke: var(--border);
  stroke-width: 1;
}

.area {
  fill: var(--spark);
  opacity: 0.1;
}

.line {
  fill: none;
  stroke: var(--spark);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.cross {
  stroke: var(--muted);
  stroke-width: 1;
  opacity: 0.6;
}

.dot {
  fill: var(--spark);
  stroke: var(--surface);
  stroke-width: 2;
}

.tip {
  position: absolute;
  bottom: calc(100% + 6px);
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 5px 9px;
  border-radius: 8px;
  background: var(--text);
  color: var(--bg);
  white-space: nowrap;
  pointer-events: none;
  box-shadow: var(--shadow);
  z-index: 5;
}

.tip strong {
  font-size: 13px;
  font-weight: 700;
}

.tip span {
  font-size: 11px;
  opacity: 0.75;
}
</style>
