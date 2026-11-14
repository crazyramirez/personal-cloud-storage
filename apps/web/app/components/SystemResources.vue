<script setup lang="ts">
/**
 * Panel → Equipo: CPU, memoria, temperatura, red, disco del sistema, alimentación y datos del
 * dispositivo, en directo (cada 5 s con la pestaña visible) y con los últimos 15 minutos.
 *
 * Forma de cada dato: un valor frente a su límite → medidor circular (el relleno lleva la gravedad
 * y va acompañado de icono + texto, nunca solo color); la evolución → mini-gráfica de una sola
 * serie; varias proporciones parecidas (núcleos, intercambio) → barras finas alineadas.
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
  return { ...m, ratio, tone, state: stateOf(tone), swapRatio: m.swapTotalBytes === 0 ? 0 : m.swapUsedBytes / m.swapTotalBytes };
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
  if (p.undervoltageNow) return { tone: 'danger', icon: 'bolt' as IconName, title: t('system.powerNow'), hint: t('system.powerNowHint') };
  if (p.undervoltageSinceBoot) return { tone: 'warn', icon: 'bolt' as IconName, title: t('system.powerPast'), hint: t('system.powerPastHint') };
  if (p.throttledNow || p.heatLimitNow) return { tone: 'warn', icon: 'alert' as IconName, title: t('system.throttledNow'), hint: '' };
  if (p.throttledSinceBoot) return { tone: 'warn', icon: 'alert' as IconName, title: t('system.throttledPast'), hint: '' };
  return { tone: 'ok', icon: 'bolt' as IconName, title: t('system.powerOk'), hint: t('system.powerOkHint') };
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
const netPeak = computed(() => Math.max(64 * 1024, ...(history.value?.rx ?? []), ...(history.value?.tx ?? [])));
const speed = (bytes: number): string => (bytes < 1 ? t('system.idle') : formatSpeed(bytes));

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
    <div class="res-head">
      <h2 id="t-equipo">{{ t('system.title') }}</h2>
      <span class="live" :class="{ on: data !== null }"><span class="pulse" aria-hidden="true" />{{ t('system.live') }}</span>
      <span class="muted small">{{ t('system.subtitle') }} · {{ t('system.last15') }}</span>
    </div>

    <div v-if="data" class="grid">
      <!-- CPU -->
      <article class="card tile" aria-labelledby="r-cpu">
        <header>
          <span class="ico"><AppIcon name="cpu" :size="18" /></span>
          <h3 id="r-cpu">{{ t('system.cpu') }}</h3>
          <span class="chip" :class="cpu.state.chip"><AppIcon :name="cpu.state.icon" :size="13" :stroke="2.2" />{{ cpu.state.label }}</span>
        </header>
        <div class="main">
          <RadialMeter :value="cpu.value / 100" :display="percent(cpu.value)" :label="`${t('system.cpuUsage')}: ${percent(cpu.value)}`" :tone="cpu.tone" :size="84" :stroke="8" />
          <dl class="facts">
            <div><dt>{{ t('system.frequency') }}</dt><dd>{{ mhz(data.cpu.mhz) }}<span v-if="data.cpu.maxMhz" class="muted"> / {{ mhz(data.cpu.maxMhz) }}</span></dd></div>
            <div><dt :title="t('system.loadHint')">{{ t('system.load') }}</dt><dd>{{ data.cpu.load.map((value) => formatNumber(value, 2)).join(' · ') }}</dd></div>
          </dl>
        </div>
        <div v-if="data.cpu.cores.length > 1" class="cores-block">
          <span class="muted small cores-label">{{ data.cpu.cores.length }} {{ t('system.cores').toLowerCase() }}</span>
          <!-- Una columna por núcleo, misma escala 0-100 %: sirve igual para 4 que para 24. -->
          <ul class="cores" :aria-label="t('system.cores')">
            <li
              v-for="(value, index) in data.cpu.cores"
              :key="index"
              class="core"
              tabindex="0"
              :title="`${t('system.core', { n: index + 1 })}: ${Math.round(value)} %`"
              :aria-label="`${t('system.core', { n: index + 1 })}: ${Math.round(value)} %`"
            >
              <span :class="`b-${level(value, 85, 95)}`" :style="{ height: `${Math.max(value, 3)}%` }" />
            </li>
          </ul>
        </div>
        <div v-if="history" class="trend">
          <Sparkline :values="history.cpu" :at="history.at" :min="0" :max="100" :format="percent" :label="t('system.cpuChart')" :tone="cpu.tone" :height="30" />
        </div>
      </article>

      <!-- Memoria -->
      <article v-if="memory" class="card tile" aria-labelledby="r-mem">
        <header>
          <span class="ico"><AppIcon name="memory" :size="18" /></span>
          <h3 id="r-mem">{{ t('system.memory') }}</h3>
          <span class="chip" :class="memory.state.chip"><AppIcon :name="memory.state.icon" :size="13" :stroke="2.2" />{{ memory.state.label }}</span>
        </header>
        <div class="main">
          <RadialMeter
            :value="memory.ratio"
            :display="percent(memory.ratio * 100)"
            :label="`${t('system.memoryUsage')}: ${percent(memory.ratio * 100)}`"
            :tone="memory.tone"
            :size="84" :stroke="8"
          />
          <dl class="facts">
            <div><dt>{{ t('system.memoryUsage') }}</dt><dd>{{ t('system.memoryOf', { used: formatBytes(memory.usedBytes), total: formatBytes(memory.totalBytes) }) }}</dd></div>
            <div><dt>{{ t('system.available') }}</dt><dd>{{ formatBytes(memory.totalBytes - memory.usedBytes) }}</dd></div>
            <div><dt>{{ t('system.appMemory') }}</dt><dd>{{ formatBytes(data.app.memoryBytes) }}</dd></div>
            <div v-if="memory.swapTotalBytes > 0">
              <dt>{{ t('system.swap') }}</dt>
              <dd>{{ memory.swapUsedBytes > 0 ? `${formatBytes(memory.swapUsedBytes)} / ${formatBytes(memory.swapTotalBytes)}` : t('system.swapNone') }}</dd>
              <span class="bar thin" aria-hidden="true"><span :style="{ width: `${Math.max(memory.swapRatio * 100, memory.swapUsedBytes > 0 ? 2 : 0)}%` }" /></span>
            </div>
          </dl>
        </div>
        <div v-if="history" class="trend">
          <Sparkline :values="history.mem" :at="history.at" :min="0" :max="100" :format="percent" :label="t('system.memoryChart')" :tone="memory.tone" :height="30" />
        </div>
      </article>

      <!-- Temperatura y alimentación -->
      <article class="card tile" aria-labelledby="r-temp">
        <header>
          <span class="ico"><AppIcon name="thermometer" :size="18" /></span>
          <h3 id="r-temp">{{ t('system.temperature') }}</h3>
          <span v-if="temperature" class="chip" :class="temperature.chip"><AppIcon :name="temperature.icon" :size="13" :stroke="2.2" />{{ temperature.label.split(':')[0] }}</span>
        </header>
        <div v-if="temperature" class="main">
          <RadialMeter
            :value="temperature.value / TEMP_LIMIT"
            :display="celsius(temperature.value)"
            :label="`${t('system.temperature')}: ${celsius(temperature.value)}`"
            :tone="temperature.tone"
            :size="84" :stroke="8"
          />
          <div class="side">
            <span class="small muted">{{ t('system.temperatureOf', { limit: celsius(TEMP_LIMIT) }) }}</span>
            <p v-if="temperature.tone !== 'accent'" class="small">{{ temperature.label }}</p>
            <div v-if="power" class="power" :class="`p-${power.tone}`">
              <span class="p-ico"><AppIcon :name="power.icon" :size="16" :stroke="2" /></span>
              <span class="p-text">
                <span class="muted small">{{ t('system.power') }}</span>
                <strong>{{ power.title }}</strong>
              </span>
            </div>
            <p v-if="power?.hint && power.tone !== 'ok'" class="small muted">{{ power.hint }}</p>
          </div>
        </div>
        <p v-else class="muted small">{{ t('system.tempNone') }}</p>
        <div v-if="history && hasTempHistory" class="trend">
          <Sparkline :values="tempHistory" :at="history.at" :min="25" :max="TEMP_LIMIT" :format="celsius" :label="t('system.temperatureChart')" :tone="temperature?.tone ?? 'accent'" :height="30" />
        </div>
      </article>

      <!-- Red -->
      <article class="card tile" aria-labelledby="r-net">
        <header>
          <span class="ico"><AppIcon name="network" :size="18" /></span>
          <h3 id="r-net">{{ t('system.network') }}</h3>
        </header>
        <div class="net">
          <div class="net-row">
            <div class="net-figure">
              <span class="muted small"><AppIcon name="download" :size="14" />{{ t('system.download') }}</span>
              <strong>{{ speed(data.network.rxBytesPerSecond) }}</strong>
            </div>
            <Sparkline v-if="history" :values="history.rx" :at="history.at" :min="0" :max="netPeak" :format="(v) => speed(v)" :label="t('system.downloadChart')" :height="28" />
          </div>
          <div class="net-row">
            <div class="net-figure">
              <span class="muted small"><AppIcon name="upload" :size="14" />{{ t('system.upload') }}</span>
              <strong>{{ speed(data.network.txBytesPerSecond) }}</strong>
            </div>
            <Sparkline v-if="history" :values="history.tx" :at="history.at" :min="0" :max="netPeak" :format="(v) => speed(v)" :label="t('system.uploadChart')" :height="28" />
          </div>
        </div>
      </article>

      <!-- Pruebas de velocidad -->
      <NetworkTest />
      <DiskSpeedTest v-if="isOwner" variant="tile" />

      <!-- Disco del sistema -->
      <article v-if="systemDisk" class="card tile" aria-labelledby="r-sd">
        <header>
          <span class="ico"><AppIcon name="sdcard" :size="18" /></span>
          <h3 id="r-sd" :title="t('system.systemDiskHint')">{{ t('system.systemDisk') }}</h3>
          <span class="chip" :class="systemDisk.state.chip"><AppIcon :name="systemDisk.state.icon" :size="13" :stroke="2.2" />{{ systemDisk.state.label }}</span>
        </header>
        <div class="main">
          <RadialMeter
            :value="systemDisk.ratio"
            :display="percent(systemDisk.ratio * 100)"
            :label="`${t('system.systemDisk')}: ${t('system.usedOf', { used: formatBytes(systemDisk.used), total: formatBytes(systemDisk.totalBytes) })}`"
            :tone="systemDisk.tone"
            :size="84" :stroke="8"
          />
          <div class="side">
            <strong>{{ t('system.free', { size: formatBytes(systemDisk.freeBytes) }) }}</strong>
            <span class="small muted">{{ t('system.usedOf', { used: formatBytes(systemDisk.used), total: formatBytes(systemDisk.totalBytes) }) }}</span>
          </div>
        </div>
      </article>

      <!-- Dispositivo -->
      <article class="card tile" aria-labelledby="r-dev">
        <header>
          <span class="ico"><AppIcon name="monitor" :size="18" /></span>
          <h3 id="r-dev">{{ t('system.device') }}</h3>
        </header>
        <dl class="kv-list">
          <div><dt>{{ t('system.model') }}</dt><dd>{{ data.host.model ?? '—' }}</dd></div>
          <div><dt>{{ t('system.name') }}</dt><dd class="mono">{{ data.host.name }}</dd></div>
          <div><dt>{{ t('system.os') }}</dt><dd>{{ data.host.os ?? '—' }}</dd></div>
          <div><dt>{{ t('system.kernel') }}</dt><dd class="mono">{{ data.host.kernel }}</dd></div>
          <div><dt>{{ t('system.uptime') }}</dt><dd>{{ duration(data.uptimeSeconds) }}</dd></div>
          <div><dt>{{ t('system.appUptime') }}</dt><dd>{{ duration(data.app.uptimeSeconds) }}</dd></div>
        </dl>
      </article>
    </div>
    <div v-else class="grid" aria-hidden="true">
      <div v-for="n in 3" :key="n" class="card tile skeleton" />
    </div>
  </section>
</template>

<style scoped>
.resources {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.res-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}

.res-head h2 {
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

/* Mosaico en columnas: tarjetas de alturas distintas sin huecos entre filas. */
.grid {
  columns: 250px;
  column-gap: 12px;
}

.grid > :deep(*) {
  break-inside: avoid;
  margin-bottom: 12px;
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

.tile header .chip {
  padding: 1px 8px;
  font-size: 11px;
}

.tile header .chip {
  margin-left: auto;
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

.main {
  display: flex;
  align-items: center;
  gap: 14px;
}

.facts,
.side {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.facts > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.facts > div {
  gap: 0;
}

.facts dt {
  font-size: 11px;
  color: var(--muted);
}

.facts dd {
  font-size: 13px;
  font-weight: 600;
}

.bar.thin {
  height: 4px;
  margin-top: 4px;
}

.cores-block {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}

.cores-label {
  flex: none;
  white-space: nowrap;
}

.cores {
  flex: 1;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 20px;
}

.core {
  flex: 1 1 0;
  max-width: 24px;
  height: 100%;
  display: flex;
  align-items: flex-end;
  border-radius: 4px 4px 0 0;
  background: var(--accent-soft);
  outline-offset: 2px;
}

.core > span {
  display: block;
  width: 100%;
  border-radius: 4px 4px 0 0;
  background: var(--accent-btn);
  transition: height 0.4s ease;
}

.core > span.b-warn {
  background: var(--warn);
}

.core > span.b-danger {
  background: var(--danger);
}

.core:hover > span {
  filter: brightness(1.15);
}

.trend {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.power {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 10px;
  background: var(--surface-2);
}

.p-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  flex: none;
}

.p-ok .p-ico {
  background: var(--ok-soft);
  color: var(--ok);
}

.p-warn .p-ico {
  background: var(--warn-soft);
  color: var(--warn);
}

.p-danger .p-ico {
  background: var(--danger-soft);
  color: var(--danger);
}

.p-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.p-text strong {
  font-size: 12px;
}

.p-text .small {
  font-size: 11px;
}

.net {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.net-row {
  display: grid;
  grid-template-columns: 96px 1fr;
  align-items: end;
  gap: 12px;
}

.net-figure {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.net-figure span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.net-figure strong {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.kv-list {
  display: flex;
  flex-direction: column;
}

.kv-list > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  border-top: 1px solid var(--border);
  font-size: 12px;
}

.kv-list > div:first-child {
  border-top: 0;
  padding-top: 0;
}

.kv-list dt {
  color: var(--muted);
}

.kv-list dd {
  text-align: right;
  font-weight: 500;
  overflow-wrap: anywhere;
}

.skeleton {
  height: 170px;
  background: linear-gradient(90deg, var(--surface) 0%, var(--surface-2) 50%, var(--surface) 100%);
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
}

@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}

@media (max-width: 420px) {
  .main {
    gap: 12px;
  }

  .net-row {
    grid-template-columns: 96px 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .live.on .pulse,
  .skeleton {
    animation: none;
  }
}
</style>
