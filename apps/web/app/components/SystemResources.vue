<script setup lang="ts">
/**
 * Panel → Equipo: dos tarjetas con la MISMA rejilla de 4 columnas iguales, para que todo quede
 * alineado en vertical y en horizontal (estilos .res-* en main.css):
 *  1. En directo: procesador · memoria · temperatura y alimentación · red.
 *  2. Sistema y pruebas: disco del sistema · dispositivo · velocidad de la red · del disco.
 * Cada celda: cabecera, cuerpo de altura fija (medidor de 72 px + hasta 3 filas de datos) y pie
 * (mini-gráfica de 15 min o nota). Se actualiza cada 5 s con la pestaña visible.
 *
 * Forma de cada dato: un valor frente a su límite → medidor circular (el relleno lleva la gravedad
 * y va con icono + texto, nunca solo color); la evolución → mini-gráfica de una sola serie.
 */
import type { ResourcesResponse } from '@pcloud/contracts';

type Tone = 'accent' | 'ok' | 'warn' | 'danger';

const session = useSession();
const isOwner = computed(() => session.user.value?.role === 'owner');

const data = ref<ResourcesResponse | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

async function refresh(): Promise<void> {
  try {
    data.value = await api<ResourcesResponse>('/system/resources');
  } catch {
    // Se conserva la última lectura; el estado de conexión ya lo enseña la cabecera.
  }
}
onMounted(() => {
  void refresh();
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') void refresh();
  }, 5000);
});
onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer);
});

// ── Gravedad: el color del medidor y su etiqueta con icono ──────────────────────────────
function level(value: number, warn: number, danger: number): Tone {
  return value >= danger ? 'danger' : value >= warn ? 'warn' : 'accent';
}
function stateOf(tone: Tone, kind: 'usage' | 'space' = 'usage'): { label: string; icon: IconName; chip: string } {
  if (tone === 'danger') return { label: kind === 'space' ? t('system.stateVeryLow') : t('system.stateCritical'), icon: 'alert', chip: 'chip-danger' };
  if (tone === 'warn') return { label: kind === 'space' ? t('system.stateLow') : t('system.stateHigh'), icon: 'alert', chip: 'chip-warn' };
  return { label: t('system.stateNormal'), icon: 'check', chip: 'chip-ok' };
}

const percent = (value: number): string => `${formatNumber(value, value < 10 ? 1 : 0)} %`;
const celsius = (value: number): string => `${formatNumber(value, 0)} °C`;
const TEMP_LIMIT = 85;

const cpu = computed(() => {
  const value = data.value?.cpu.percent ?? 0;
  const tone = level(value, 85, 95);
  return { value, tone, state: stateOf(tone) };
});

const memory = computed(() => {
  const m = data.value?.memory;
  if (m === undefined || m.totalBytes === 0) return null;
  const ratio = m.usedBytes / m.totalBytes;
  const tone = level(ratio * 100, 85, 95);
  return { ...m, ratio, tone, state: stateOf(tone) };
});

const temperature = computed(() => {
  const value = data.value?.temperature ?? null;
  if (value === null) return null;
  const tone = level(value, 70, 80);
  const label = value >= 80 ? t('system.tempHot') : value >= 60 ? t('system.tempWarm') : t('system.tempCool');
  return { value, tone, label, icon: (tone === 'accent' ? 'check' : 'alert') as IconName, chip: tone === 'accent' ? 'chip-ok' : tone === 'warn' ? 'chip-warn' : 'chip-danger' };
});

const power = computed(() => {
  const p = data.value?.power;
  if (p === null || p === undefined) return null;
  if (p.undervoltageNow) return { tone: 'danger', title: t('system.powerNow'), hint: t('system.powerNowHint') };
  if (p.undervoltageSinceBoot) return { tone: 'warn', title: t('system.powerPast'), hint: t('system.powerPastHint') };
  if (p.throttledNow || p.heatLimitNow) return { tone: 'warn', title: t('system.throttledNow'), hint: '' };
  if (p.throttledSinceBoot) return { tone: 'warn', title: t('system.throttledPast'), hint: '' };
  return { tone: 'ok', title: t('system.powerOk'), hint: t('system.powerOkHint') };
});

const systemDisk = computed(() => {
  const d = data.value?.systemDisk;
  if (d === null || d === undefined || d.totalBytes === 0) return null;
  const used = d.totalBytes - d.freeBytes;
  const ratio = used / d.totalBytes;
  const tone = level(ratio * 100, 90, 95);
  return { ...d, used, ratio, tone, state: stateOf(tone, 'space') };
});

const history = computed(() => data.value?.history ?? null);
const tempHistory = computed(() => history.value?.temp ?? []);
const hasTempHistory = computed(() => tempHistory.value.some((value) => value !== null));
const speed = (bytes: number): string => (bytes < 1 ? t('system.idle') : formatSpeed(bytes));
/** Tráfico total (recibe + envía) para la mini-gráfica de la red: una sola serie. */
const traffic = computed(() => {
  const h = history.value;
  return h === null ? [] : h.rx.map((rx, index) => rx + (h.tx[index] ?? 0));
});
const trafficPeak = computed(() => Math.max(64 * 1024, ...traffic.value));

function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return t('system.durationDays', { d, h });
  if (h > 0) return t('system.durationHours', { h, m });
  return t('system.durationMinutes', { m: Math.max(1, m) });
}
const mhz = (value: number | null): string => (value === null ? '—' : value >= 1000 ? `${formatNumber(value / 1000, 1)} GHz` : `${value} MHz`);
</script>

<template>
  <section class="resources" aria-labelledby="t-equipo">
    <div class="head">
      <h2 id="t-equipo">{{ t('system.title') }}</h2>
      <span class="live" :class="{ on: data !== null }"><span class="pulse" aria-hidden="true" />{{ t('system.live') }}</span>
      <span class="muted small">{{ t('system.subtitle') }} · {{ t('system.last15') }}</span>
    </div>

    <template v-if="data">
      <!-- Tarjeta 1: en directo -->
      <div class="card res-card">
        <article class="res-cell" aria-labelledby="r-cpu">
          <header class="res-cell-head">
            <span class="res-ico"><AppIcon name="cpu" :size="15" /></span>
            <h3 id="r-cpu">{{ t('system.cpu') }}</h3>
            <span class="chip" :class="cpu.state.chip"><AppIcon :name="cpu.state.icon" :size="12" :stroke="2.2" />{{ cpu.state.label }}</span>
          </header>
          <div class="res-cell-body">
            <RadialMeter :value="cpu.value / 100" :display="percent(cpu.value)" :label="`${t('system.cpuUsage')}: ${percent(cpu.value)}`" :tone="cpu.tone" :size="72" :stroke="7" />
            <div class="res-rows">
              <div class="res-row"><span>{{ t('system.frequency') }}</span><strong>{{ mhz(data.cpu.mhz) }}</strong></div>
              <div class="res-row"><span :title="t('system.loadHint')">{{ t('system.load') }}</span><strong>{{ data.cpu.load.map((value) => formatNumber(value, 2)).join(' · ') }}</strong></div>
              <div v-if="data.cpu.cores.length > 1" class="res-row">
                <span>{{ t('system.coresCount', { n: data.cpu.cores.length }) }}</span>
                <ul class="cores" :aria-label="t('system.cores')">
                  <li
                    v-for="(value, index) in data.cpu.cores"
                    :key="index"
                    class="core"
                    tabindex="0"
                    :title="`${t('system.core', { n: index + 1 })}: ${Math.round(value)} %`"
                    :aria-label="`${t('system.core', { n: index + 1 })}: ${Math.round(value)} %`"
                  >
                    <span :class="`b-${level(value, 85, 95)}`" :style="{ height: `${Math.max(value, 8)}%` }" />
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <div class="res-cell-foot">
            <Sparkline v-if="history" :values="history.cpu" :at="history.at" :min="0" :max="100" :format="percent" :label="t('system.cpuChart')" :tone="cpu.tone" :height="30" />
          </div>
        </article>

        <article class="res-cell" aria-labelledby="r-mem">
          <header class="res-cell-head">
            <span class="res-ico"><AppIcon name="memory" :size="15" /></span>
            <h3 id="r-mem">{{ t('system.memory') }}</h3>
            <span v-if="memory" class="chip" :class="memory.state.chip"><AppIcon :name="memory.state.icon" :size="12" :stroke="2.2" />{{ memory.state.label }}</span>
          </header>
          <div v-if="memory" class="res-cell-body">
            <RadialMeter :value="memory.ratio" :display="percent(memory.ratio * 100)" :label="`${t('system.memoryUsage')}: ${percent(memory.ratio * 100)}`" :tone="memory.tone" :size="72" :stroke="7" />
            <div class="res-rows">
              <div class="res-row"><span>{{ t('system.inUse') }}</span><strong>{{ formatBytes(memory.usedBytes) }}</strong></div>
              <div class="res-row"><span>{{ t('system.available') }}</span><strong>{{ formatBytes(memory.totalBytes - memory.usedBytes) }}</strong></div>
              <div class="res-row"><span>{{ t('system.swap') }}</span><strong>{{ memory.swapUsedBytes === 0 ? t('system.swapNone') : formatBytes(memory.swapUsedBytes) }}</strong></div>
            </div>
          </div>
          <div class="res-cell-foot">
            <Sparkline v-if="history && memory" :values="history.mem" :at="history.at" :min="0" :max="100" :format="percent" :label="t('system.memoryChart')" :tone="memory.tone" :height="30" />
          </div>
        </article>

        <article class="res-cell" aria-labelledby="r-temp">
          <header class="res-cell-head">
            <span class="res-ico"><AppIcon name="thermometer" :size="15" /></span>
            <h3 id="r-temp">{{ t('system.temperature') }}</h3>
            <span v-if="temperature" class="chip" :class="temperature.chip"><AppIcon :name="temperature.icon" :size="12" :stroke="2.2" />{{ temperature.label.split(':')[0] }}</span>
          </header>
          <div class="res-cell-body">
            <RadialMeter
              :value="temperature ? temperature.value / TEMP_LIMIT : null"
              :display="temperature ? celsius(temperature.value) : '—'"
              :label="temperature ? `${t('system.temperature')}: ${celsius(temperature.value)}` : t('system.tempNone')"
              :tone="temperature?.tone ?? 'accent'"
              :size="72"
              :stroke="7"
            />
            <div class="res-rows">
              <div class="res-row"><span>{{ t('system.limit') }}</span><strong>{{ temperature ? celsius(TEMP_LIMIT) : '—' }}</strong></div>
              <div class="res-row">
                <span><AppIcon name="bolt" :size="12" :stroke="2" />{{ t('system.power') }}</span>
                <strong :class="power ? `t-${power.tone}` : ''" :title="power?.hint">{{ power?.title ?? t('system.unavailable') }}</strong>
              </div>
              <p v-if="power && power.tone !== 'ok' && power.hint" class="res-note">{{ power.hint }}</p>
              <p v-else-if="!temperature" class="res-note">{{ t('system.tempNone') }}</p>
            </div>
          </div>
          <div class="res-cell-foot">
            <Sparkline v-if="history && hasTempHistory" :values="tempHistory" :at="history.at" :min="25" :max="TEMP_LIMIT" :format="celsius" :label="t('system.temperatureChart')" :tone="temperature?.tone ?? 'accent'" :height="30" />
          </div>
        </article>

        <article class="res-cell" aria-labelledby="r-net">
          <header class="res-cell-head">
            <span class="res-ico"><AppIcon name="network" :size="15" /></span>
            <h3 id="r-net">{{ t('system.network') }}</h3>
          </header>
          <div class="res-cell-body">
            <div class="net-figures">
              <div><span class="muted"><AppIcon name="download" :size="13" />{{ t('system.download') }}</span><strong>{{ speed(data.network.rxBytesPerSecond) }}</strong></div>
              <div><span class="muted"><AppIcon name="upload" :size="13" />{{ t('system.upload') }}</span><strong>{{ speed(data.network.txBytesPerSecond) }}</strong></div>
            </div>
          </div>
          <div class="res-cell-foot">
            <Sparkline v-if="history" :values="traffic" :at="history.at" :min="0" :max="trafficPeak" :format="(v) => speed(v)" :label="t('system.trafficChart')" :height="30" />
          </div>
        </article>
      </div>

      <!-- Tarjeta 2: sistema y pruebas -->
      <div class="card res-card">
        <article class="res-cell" aria-labelledby="r-sd">
          <header class="res-cell-head">
            <span class="res-ico"><AppIcon name="sdcard" :size="15" /></span>
            <h3 id="r-sd">{{ t('system.systemDisk') }}</h3>
            <span v-if="systemDisk" class="chip" :class="systemDisk.state.chip"><AppIcon :name="systemDisk.state.icon" :size="12" :stroke="2.2" />{{ systemDisk.state.label }}</span>
          </header>
          <div v-if="systemDisk" class="res-cell-body">
            <RadialMeter
              :value="systemDisk.ratio"
              :display="percent(systemDisk.ratio * 100)"
              :label="`${t('system.systemDisk')}: ${t('system.usedOf', { used: formatBytes(systemDisk.used), total: formatBytes(systemDisk.totalBytes) })}`"
              :tone="systemDisk.tone"
              :size="72"
              :stroke="7"
            />
            <div class="res-rows">
              <div class="res-row"><span>{{ t('system.freeLabel') }}</span><strong>{{ formatBytes(systemDisk.freeBytes) }}</strong></div>
              <div class="res-row"><span>{{ t('system.inUse') }}</span><strong>{{ formatBytes(systemDisk.used) }}</strong></div>
              <div class="res-row"><span>{{ t('system.total') }}</span><strong>{{ formatBytes(systemDisk.totalBytes) }}</strong></div>
            </div>
          </div>
          <div class="res-cell-foot">
            <p class="res-note">{{ t('system.systemDiskHint') }}</p>
          </div>
        </article>

        <article class="res-cell" aria-labelledby="r-dev">
          <header class="res-cell-head">
            <span class="res-ico"><AppIcon name="monitor" :size="15" /></span>
            <h3 id="r-dev">{{ t('system.device') }}</h3>
          </header>
          <div class="res-rows">
            <div class="res-row"><span>{{ t('system.model') }}</span><strong>{{ data.host.model ?? '—' }}</strong></div>
            <div class="res-row"><span>{{ t('system.name') }}</span><strong class="mono">{{ data.host.name }}</strong></div>
            <div class="res-row"><span>{{ t('system.os') }}</span><strong>{{ data.host.os ?? '—' }}</strong></div>
            <div class="res-row"><span>{{ t('system.kernel') }}</span><strong class="mono">{{ data.host.kernel }}</strong></div>
            <div class="res-row"><span>{{ t('system.uptime') }}</span><strong>{{ duration(data.uptimeSeconds) }}</strong></div>
            <div class="res-row"><span>{{ t('system.appUptime') }}</span><strong>{{ duration(data.app.uptimeSeconds) }}</strong></div>
            <div class="res-row"><span>{{ t('system.appMemory') }}</span><strong>{{ formatBytes(data.app.memoryBytes) }}</strong></div>
          </div>
        </article>

        <NetworkTest />
        <DiskSpeedTest v-if="isOwner" variant="tile" />
        <div v-else class="res-cell" aria-hidden="true" />
      </div>
    </template>
    <div v-else class="card res-card" aria-hidden="true">
      <div v-for="n in 4" :key="n" class="res-cell skeleton" />
    </div>
  </section>
</template>

<style scoped>
.resources {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}

.head h2 {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 9px 2px 8px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
}

.live.on .pulse {
  background: var(--ok);
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.small {
  font-size: 12px;
}

/* Núcleos: una columna por núcleo dentro de su fila de datos. */
.cores {
  flex: 1;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 2px;
  height: 14px;
  min-width: 0;
  max-width: 96px;
}

.core {
  flex: 1 1 0;
  max-width: 10px;
  height: 100%;
  display: flex;
  align-items: flex-end;
  border-radius: 2px;
  background: var(--accent-soft);
}

.core > span {
  display: block;
  width: 100%;
  border-radius: 2px;
  background: var(--accent-btn);
  transition: height 0.4s ease;
}

.core > span.b-warn {
  background: var(--warn);
}

.core > span.b-danger {
  background: var(--danger);
}

.t-ok {
  color: var(--ok);
}

.t-warn {
  color: var(--warn);
}

.t-danger {
  color: var(--danger);
}

.net-figures {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.net-figures > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.net-figures span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.net-figures strong {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.02em;
  white-space: nowrap;
}

.skeleton {
  height: 168px;
  background: linear-gradient(90deg, var(--surface) 0%, var(--surface-2) 50%, var(--surface) 100%);
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
}

@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .live.on .pulse,
  .skeleton {
    animation: none;
  }
}
</style>
