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
const tileRows = computed(() => [
  { key: 'w', label: t('settings.write'), value: speed.value ? `${formatNumber(speed.value.writeMBps, 3)} MB/s` : '—' },
  { key: 'r', label: t('settings.read'), value: speed.value ? `${formatNumber(speed.value.readMBps, 3)} MB/s` : '—' },
  { key: 'i', label: t('system.randomShort'), value: speed.value ? `${formatNumber(speed.value.randomReadIops, 3)} IOPS` : '—' },
]);
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
  <!-- Panel → Equipo: celda compacta con las mismas 3 filas siempre (alto constante). -->
  <article v-if="tile" class="res-cell" aria-labelledby="r-diskspeed">
    <header class="res-cell-head">
      <span class="res-ico"><AppIcon name="drive" :size="15" /></span>
      <h3 id="r-diskspeed">{{ t('settings.diskSpeed') }}</h3>
    </header>
    <div class="res-cell-body">
      <div class="res-rows">
        <div v-for="row in tileRows" :key="row.key" class="res-row"><span>{{ row.label }}</span><strong>{{ busy ? '…' : row.value }}</strong></div>
        <div class="bar small-bar" aria-hidden="true"><span :style="{ width: `${speed && !busy ? barPercent(speed.readMBps, 150) : busy ? 8 : 0}%` }" /></div>
      </div>
    </div>
    <div class="res-cell-foot">
      <p v-if="error" role="alert" class="res-note err">{{ error }}</p>
      <p v-else class="res-note">{{ busy ? t('settings.measuring') : speed ? `${verdict(speed.readMBps)} · ${formatRelative(speed.testedAt)}` : t('system.diskTestIntro') }}</p>
      <button type="button" class="btn cell-btn" :disabled="busy" @click="run">
        <span v-if="busy" class="spin" aria-hidden="true" /><AppIcon v-else name="gauge" />{{ busy ? t('settings.measuring') : speed ? t('settings.measureAgain') : t('settings.measure') }}
      </button>
    </div>
  </article>

  <section v-else class="card sec" aria-labelledby="s-speed">
    <header>
      <AppIcon name="gauge" />
      <h2 id="s-speed">{{ t('settings.diskSpeed') }}</h2>
    </header>
    <p class="muted">{{ t('settings.diskSpeedIntro') }}</p>
    <div v-if="speed" class="speed">
      <div v-for="row in rows" :key="row.key" class="meter">
        <div class="meter-head"><span>{{ row.label }}</span><strong>{{ row.value }}</strong></div>
        <div class="bar"><span :style="{ width: `${row.pct}%` }" /></div>
        <span class="muted small">{{ row.hint }}</span>
      </div>
      <p class="muted small">{{ t('settings.measuredAt', { date: formatDate(speed.testedAt), seconds: formatNumber(speed.durationMs / 1000) }) }}</p>
    </div>
    <p v-if="error" role="alert" class="notice notice-danger">{{ error }}</p>
    <div>
      <button type="button" class="btn btn-primary" :disabled="busy" @click="run">
        <span v-if="busy" class="spin" aria-hidden="true" /><AppIcon v-else name="gauge" />{{ busy ? t('settings.measuring') : speed ? t('settings.measureAgain') : t('settings.measure') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.small-bar {
  height: 4px;
  margin-top: 4px;
  border-radius: 2px;
  background: var(--accent-soft);
  overflow: hidden;
}

.small-bar > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent-btn);
  transition: width 0.4s ease;
}

.cell-btn {
  align-self: flex-start;
  min-height: 36px;
  font-size: 13px;
}

.err {
  color: var(--danger);
}

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





.small {
  font-size: 12px;
}

.speed {
  display: flex;
  flex-direction: column;
  gap: 14px;
}


.meter {
  display: flex;
  flex-direction: column;
  gap: 6px;
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



.meter .bar {
  height: 10px;
  border-radius: 5px;
  background: var(--accent-soft);
  overflow: hidden;
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
