<script setup lang="ts">
/**
 * Progreso de la reparación automática del disco (ADR-0032): pasos, paso actual, tiempo que lleva y
 * una barra estimada con lo que tardó la última pasada. La herramienta de reparación no informa de
 * su avance, así que la barra es una estimación y nunca llega sola al 100 %.
 */
import type { VolumeRepairStatus, VolumeRepairStep } from '@pcloud/contracts';

const props = defineProps<{ repair: VolumeRepairStatus }>();
const { serverNow } = useStorage();

const now = ref(serverNow());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => {
    now.value = serverNow();
  }, 1000);
});
onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer);
});

/** «Revisar y reparar» y «Comprobar» son pasadas completas por el disco; desmontar y montar, segundos. */
const STEPS: Array<{ key: VolumeRepairStep | 'mount'; label: () => string }> = [
  { key: 'unmount', label: () => t('volume.repairStepUnmount') },
  { key: 'scan', label: () => t('volume.repairStepScan') },
  { key: 'verify', label: () => t('volume.repairStepVerify') },
  { key: 'mount', label: () => t('volume.repairStepMount') },
];

const current = computed(() => {
  const step = props.repair.step ?? (props.repair.phase === 'pending' ? 'unmount' : 'scan');
  return STEPS.findIndex((s) => s.key === step);
});
/** Al arrancar tras un corte de luz no hay que desmontar nada: ese paso no se enseña. */
const steps = computed(() => (props.repair.trigger === 'readonly' ? STEPS : STEPS.filter((s) => s.key !== 'unmount')));

function seconds(from: string | null): number {
  const start = from === null ? Number.NaN : Date.parse(from);
  return Number.isFinite(start) ? Math.max(0, Math.round((now.value - start) / 1000)) : 0;
}
function duration(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? t('volume.repairDurationMS', { m, s }) : t('volume.repairDurationS', { s });
}

const elapsed = computed(() => seconds(props.repair.startedAt));
const stepElapsed = computed(() => seconds(props.repair.stepStartedAt ?? props.repair.startedAt));
const estimate = computed(() => props.repair.estimateSeconds);
const inPass = computed(() => props.repair.step === 'scan' || props.repair.step === 'verify');
/** Porcentaje estimado del paso en curso (máx. 95 % hasta que el servidor diga que ha terminado). */
const percent = computed(() => {
  if (!inPass.value || estimate.value === null || estimate.value <= 0) return null;
  return Math.min(95, Math.round((stepElapsed.value / estimate.value) * 100));
});
const slow = computed(() => inPass.value && estimate.value !== null && stepElapsed.value > estimate.value * 1.2);
</script>

<template>
  <div class="repair" role="status" aria-live="polite">
    <ol class="stepper">
      <li
        v-for="item in steps"
        :key="item.key"
        :class="{ done: STEPS.indexOf(item) < current, now: STEPS.indexOf(item) === current }"
      >
        <span class="mark" aria-hidden="true">
          <AppIcon v-if="STEPS.indexOf(item) < current" name="check" :size="14" />
          <span v-else-if="STEPS.indexOf(item) === current" class="spin" />
        </span>
        <span>{{ item.label() }}</span>
      </li>
    </ol>

    <div v-if="inPass" class="meter">
      <div class="bar" :class="{ indeterminate: percent === null }">
        <span :style="percent === null ? undefined : { width: `${percent}%` }" />
      </div>
      <p class="muted small">
        {{ t('volume.repairStepElapsed', { time: duration(stepElapsed) }) }}
        <template v-if="estimate !== null"> · {{ t('volume.repairEstimate', { time: duration(estimate) }) }}</template>
      </p>
      <p v-if="slow" class="muted small">{{ t('volume.repairSlow') }}</p>
    </div>
    <p class="muted small">{{ t('volume.repairElapsed', { time: duration(elapsed) }) }}</p>
  </div>
</template>

<style scoped>
.repair {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border-radius: 12px;
  background: var(--surface-2);
}

.stepper {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.stepper li {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--muted);
}

.stepper li.now {
  color: var(--text);
  font-weight: 600;
}

.stepper li.done {
  color: var(--text);
}

.mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  flex: none;
  border: 2px solid var(--border);
}

li.done .mark {
  border-color: var(--ok);
  background: var(--ok);
  color: var(--surface);
}

li.now .mark {
  border-color: var(--warn);
}

.spin {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--warn);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}

.meter {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bar.indeterminate > span {
  width: 30%;
  animation: slide 1.6s ease-in-out infinite;
}

@keyframes slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(340%);
  }
}

.small {
  font-size: 13px;
}

@media (prefers-reduced-motion: reduce) {
  .spin,
  .bar.indeterminate > span {
    animation: none;
  }
}
</style>
