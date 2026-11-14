<script setup lang="ts">
/**
 * Prueba de velocidad del disco de datos (propietario): escritura y lectura secuenciales reales
 * (sin caché) y acceso aleatorio de 4 KB. Se usa en Ajustes (`section`) y en Panel → Equipo
 * (`tile`, compacta). El último resultado se recuerda en este navegador.
 */
import type { DiskSpeedResponse } from '@pcloud/contracts';

const props = withDefaults(defineProps<{ variant?: 'section' | 'tile' }>(), { variant: 'section' });
const tile = computed(() => props.variant === 'tile');

const speed = ref<DiskSpeedResponse | null>(null);
const busy = ref(false);
const error = liveText();
const KEY = 'pcloud.diskspeed';
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as DiskSpeedResponse | null;
  if (saved !== null && typeof saved.readMBps === 'number') speed.value = saved;
} catch {
  // Sin almacenamiento: sin resultado previo.
}

async function run(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    speed.value = await api<DiskSpeedResponse>('/system/disk-speed', { method: 'POST', timeoutMs: 240_000 });
    try {
      localStorage.setItem(KEY, JSON.stringify(speed.value));
    } catch {
      // ignorar
    }
  } catch (caught) {
    error.value = errorText(caught instanceof ApiError ? caught : null, 'settings.speedFailed');
  } finally {
    busy.value = false;
  }
}

/** Escala: un HDD USB 3 de 2,5" ronda 100-130 MB/s secuencial; 150 = barra llena. */
const barPercent = (value: number, max: number): number => Math.max(3, Math.min(100, Math.round((value / max) * 100)));
const verdict = (mbps: number): string => t(mbps >= 80 ? 'settings.verdictGreat' : mbps >= 40 ? 'settings.verdictOk' : mbps >= 15 ? 'settings.verdictSlow' : 'settings.verdictVerySlow');
const rows = computed(() => {
  const s = speed.value;
  if (s === null) return [];
  return [
    { key: 'w', label: t('settings.write'), value: `${formatNumber(s.writeMBps, 3)} MB/s`, pct: barPercent(s.writeMBps, 150), hint: verdict(s.writeMBps) },
    { key: 'r', label: t('settings.read'), value: `${formatNumber(s.readMBps, 3)} MB/s`, pct: barPercent(s.readMBps, 150), hint: verdict(s.readMBps) },
    { key: 'i', label: t('settings.randomAccess'), value: `${formatNumber(s.randomReadIops, 3)} IOPS`, pct: barPercent(s.randomReadIops, 200), hint: t('settings.randomHint') },
  ];
});
</script>

<template>
  <component :is="tile ? 'article' : 'section'" class="card" :class="tile ? 'tile' : 'sec'" aria-labelledby="s-speed">
    <header>
      <span v-if="tile" class="ico"><AppIcon name="drive" :size="18" /></span>
      <AppIcon v-else name="gauge" />
      <component :is="tile ? 'h3' : 'h2'" id="s-speed">{{ t('settings.diskSpeed') }}</component>
    </header>
    <p v-if="!tile" class="muted">{{ t('settings.diskSpeedIntro') }}</p>
    <p v-else-if="!speed" class="muted small">{{ t('system.diskTestIntro') }}</p>

    <div v-if="speed" class="speed">
      <div v-for="row in rows" :key="row.key" class="meter">
        <div class="meter-head"><span>{{ row.label }}</span><strong>{{ row.value }}</strong></div>
        <div class="bar"><span :style="{ width: `${row.pct}%` }" /></div>
        <span v-if="!tile || row.key !== 'i'" class="muted small">{{ row.hint }}</span>
      </div>
      <p class="muted small">{{ tile ? formatRelative(speed.testedAt) : t('settings.measuredAt', { date: formatDate(speed.testedAt), seconds: formatNumber(speed.durationMs / 1000) }) }}</p>
    </div>
    <p v-if="error" role="alert" class="notice notice-danger">{{ error }}</p>
    <div>
      <button type="button" class="btn" :class="tile ? '' : 'btn-primary'" :disabled="busy" @click="run">
        <span v-if="busy" class="spin" aria-hidden="true" /><AppIcon v-else name="gauge" />{{ busy ? t('settings.measuring') : speed ? t('settings.measureAgain') : t('settings.measure') }}
      </button>
    </div>
  </component>
</template>

<style scoped>
.sec {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
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

.tile {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 14px;
}

.tile header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tile h3 {
  font-size: 14px;
  font-weight: 650;
}

.ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--accent-soft);
  color: var(--accent);
  flex: none;
}

.small {
  font-size: 12px;
}

.speed {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.tile .speed {
  gap: 8px;
}

.meter {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tile .meter {
  gap: 3px;
}

.meter-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
}

.meter-head strong {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}

.tile .meter-head span {
  font-size: 12px;
  color: var(--muted);
}

.tile .meter-head strong {
  font-size: 14px;
}

.meter .bar {
  height: 10px;
  border-radius: 5px;
  background: var(--accent-soft);
  overflow: hidden;
}

.tile .meter .bar {
  height: 6px;
  border-radius: 3px;
}

.meter .bar span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent-btn);
  transition: width 0.6s cubic-bezier(0.2, 0.9, 0.3, 1);
}

.spin {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
