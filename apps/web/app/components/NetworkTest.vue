<script setup lang="ts">
/**
 * Prueba de red entre ESTE dispositivo y el servidor (Wi-Fi, cable o Tailscale): latencia,
 * bajada y subida reales. Los datos salen de la memoria del servidor y la subida se descarta:
 * no se toca ningún disco. Unos 15 s en total; el último resultado se recuerda en este navegador.
 */
const props = withDefaults(defineProps<{ variant?: 'tile' | 'section' }>(), { variant: 'tile' });
const tile = computed(() => props.variant === 'tile');

const KEY = 'pcloud.nettest';
const PHASE_SECONDS = 5;
const MiB = 1024 * 1024;

interface Result {
  latencyMs: number;
  downMbps: number;
  upMbps: number;
  at: string;
}

const result = ref<Result | null>(null);
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Result | null;
  if (saved !== null && typeof saved.downMbps === 'number') result.value = saved;
} catch {
  // Sin almacenamiento: sin resultado previo.
}

type Phase = 'idle' | 'latency' | 'download' | 'upload';
const phase = ref<Phase>('idle');
const live = ref(0);
const error = liveText();
let abort: AbortController | null = null;

const now = (): number => performance.now();
const mbps = (bytes: number, ms: number): number => (ms <= 0 ? 0 : (bytes * 8) / (ms / 1000) / 1e6);

async function latency(signal: AbortSignal): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const start = now();
    await fetch('/api/v1/system/health', { cache: 'no-store', signal });
    if (i > 0) samples.push(now() - start); // la primera abre la conexión
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

async function download(bytes: number, signal: AbortSignal): Promise<{ bytes: number; ms: number }> {
  const start = now();
  const response = await fetch(`/api/v1/system/nettest/download?bytes=${bytes}`, { cache: 'no-store', credentials: 'same-origin', signal });
  if (!response.ok || response.body === null) throw new Error(String(response.status));
  const reader = response.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    live.value = mbps(got, now() - start);
  }
  return { bytes: got, ms: now() - start };
}

async function measureDownload(signal: AbortSignal): Promise<number> {
  // Calentamiento corto para elegir un tamaño que dure ~5 s a esa velocidad.
  const warm = await download(2 * MiB, signal);
  const bytesPerSecond = warm.bytes / Math.max(0.05, warm.ms / 1000);
  const size = Math.round(Math.min(256 * MiB, Math.max(4 * MiB, bytesPerSecond * PHASE_SECONDS)));
  const main = await download(size, signal);
  return mbps(main.bytes, main.ms);
}

async function measureUpload(signal: AbortSignal): Promise<number> {
  const chunk = new Uint8Array(4 * MiB);
  for (let offset = 0; offset < chunk.length; offset += 65536) crypto.getRandomValues(chunk.subarray(offset, offset + 65536));
  const start = now();
  let sent = 0;
  while (now() - start < PHASE_SECONDS * 1000 && sent < 128 * MiB) {
    const response = await fetch('/api/v1/system/nettest/upload', {
      method: 'POST',
      body: chunk,
      headers: { 'content-type': 'application/offset+octet-stream', 'x-pcloud-request': '1' },
      credentials: 'same-origin',
      signal,
    });
    if (!response.ok) throw new Error(String(response.status));
    sent += chunk.length;
    live.value = mbps(sent, now() - start);
  }
  return mbps(sent, now() - start);
}

async function run(): Promise<void> {
  abort?.abort();
  abort = new AbortController();
  const { signal } = abort;
  const timeout = setTimeout(() => abort?.abort(), 60_000);
  error.value = '';
  try {
    phase.value = 'latency';
    live.value = 0;
    const latencyMs = await latency(signal);
    phase.value = 'download';
    live.value = 0;
    const downMbps = await measureDownload(signal);
    phase.value = 'upload';
    live.value = 0;
    const upMbps = await measureUpload(signal);
    result.value = { latencyMs, downMbps, upMbps, at: new Date().toISOString() };
    try {
      localStorage.setItem(KEY, JSON.stringify(result.value));
    } catch {
      // ignorar
    }
  } catch {
    if (!signal.aborted || phase.value !== 'idle') error.value = () => t('system.netTestFailed');
  } finally {
    clearTimeout(timeout);
    phase.value = 'idle';
  }
}

function stop(): void {
  phase.value = 'idle';
  abort?.abort();
}
onBeforeUnmount(() => abort?.abort());

const busy = computed(() => phase.value !== 'idle');
const fmt = (value: number): string => `${formatNumber(value, value < 10 ? 1 : 0)} Mbit/s`;
/** Escala de las barras: 500 Mbit/s = llena (más de lo que da un HDD por USB en la Pi). */
const pct = (value: number): number => Math.max(3, Math.min(100, Math.round((value / 500) * 100)));
function verdict(value: number): string {
  return t(value >= 300 ? 'system.netGreat' : value >= 80 ? 'system.netGood' : value >= 20 ? 'system.netFair' : 'system.netSlow');
}
const phaseLabel = computed(() => (phase.value === 'idle' ? '' : t(`system.netPhase_${phase.value}`)));

// ── Variante de Ajustes: tres medidores con barra y valoración, como la velocidad del disco ──
const fmtMs = (ms: number): string => `${formatNumber(ms, ms < 10 ? 1 : 0)} ms`;
/** Latencia: menos es mejor (≤ 5 ms = barra llena, ≥ 200 ms = casi vacía). */
const latencyPct = (ms: number): number => Math.max(3, Math.min(100, Math.round(100 - ((ms - 5) / 195) * 100)));
const latencyVerdict = (ms: number): string => t(ms <= 20 ? 'system.netLatencyGreat' : ms <= 60 ? 'system.netLatencyGood' : 'system.netLatencyHigh');
const meters = computed(() => {
  const r = busy.value ? null : result.value;
  const meter = (key: 'download' | 'upload' | 'latency', label: string, value: number | null, pctOf: (v: number) => number, text: (v: number) => string, hint: (v: number) => string) => {
    const running = phase.value === key;
    const shown = running && key !== 'latency' ? live.value : value;
    return {
      key,
      label,
      running,
      value: running && key === 'latency' ? '…' : shown === null ? '—' : text(shown),
      pct: shown === null ? 0 : running && key === 'latency' ? 8 : pctOf(shown),
      hint: running ? phaseLabel.value : value === null ? '' : hint(value),
    };
  };
  return [
    meter('download', t('system.netDown'), r?.downMbps ?? null, pct, fmt, verdict),
    meter('upload', t('system.netUp'), r?.upMbps ?? null, pct, fmt, verdict),
    meter('latency', t('system.netLatency'), r?.latencyMs ?? null, latencyPct, fmtMs, latencyVerdict),
  ];
});
</script>

<template>
  <article v-if="tile" class="res-cell" aria-labelledby="r-nettest">
    <header class="res-cell-head">
      <span class="res-ico"><AppIcon name="gauge" :size="15" /></span>
      <h3 id="r-nettest">{{ t('system.netTest') }}</h3>
    </header>
    <!-- Siempre las mismas 3 filas (con «—» antes de medir): la celda no cambia de alto. -->
    <div class="res-cell-body">
      <div class="res-rows" aria-live="polite">
        <div class="res-row" :class="{ active: phase === 'download' }">
          <span><AppIcon name="download" :size="12" />{{ t('system.netDown') }}</span>
          <strong>{{ phase === 'download' ? fmt(live) : result && !busy ? fmt(result.downMbps) : '—' }}</strong>
        </div>
        <div class="res-row" :class="{ active: phase === 'upload' }">
          <span><AppIcon name="upload" :size="12" />{{ t('system.netUp') }}</span>
          <strong>{{ phase === 'upload' ? fmt(live) : result && !busy ? fmt(result.upMbps) : '—' }}</strong>
        </div>
        <div class="res-row" :class="{ active: phase === 'latency' }">
          <span><AppIcon name="clock" :size="12" />{{ t('system.netLatency') }}</span>
          <strong>{{ phase === 'latency' ? '…' : result && !busy ? `${formatNumber(result.latencyMs, result.latencyMs < 10 ? 1 : 0)} ms` : '—' }}</strong>
        </div>
        <div class="bar" aria-hidden="true"><span :class="{ idle: !busy }" :style="{ width: `${busy ? (phase === 'latency' ? 8 : pct(live)) : result ? pct(result.downMbps) : 0}%` }" /></div>
      </div>
    </div>
    <div class="res-cell-foot">
      <p v-if="error" role="alert" class="res-note err">{{ error }}</p>
      <p v-else class="res-note">{{ busy ? phaseLabel : result ? `${verdict(result.downMbps)} · ${formatRelative(result.at)}` : t('system.netTestIntro') }}</p>
      <button v-if="busy" type="button" class="btn" @click="stop"><AppIcon name="close" />{{ t('system.netStop') }}</button>
      <button v-else type="button" class="btn" @click="run"><AppIcon name="gauge" />{{ result ? t('system.netAgain') : t('system.netRun') }}</button>
    </div>
  </article>

  <section v-else class="card sec" aria-labelledby="s-net">
    <header>
      <AppIcon name="network" />
      <h2 id="s-net">{{ t('system.netTest') }}</h2>
    </header>
    <p class="muted">{{ t('system.netTestIntroLong') }}</p>
    <div class="speed" aria-live="polite">
      <div v-for="m in meters" :key="m.key" class="meter" :class="{ running: m.running }">
        <div class="meter-head"><span>{{ m.label }}</span><strong>{{ m.value }}</strong></div>
        <div class="mbar"><span :style="{ width: `${m.pct}%` }" /></div>
        <span class="muted small">{{ m.hint || '\u00a0' }}</span>
      </div>
    </div>
    <p v-if="result && !busy" class="muted small">{{ t('system.netMeasuredAt', { when: formatRelative(result.at) }) }}</p>
    <p v-if="error" role="alert" class="notice notice-danger">{{ error }}</p>
    <div class="foot">
      <button v-if="busy" type="button" class="btn" @click="stop"><AppIcon name="close" />{{ t('system.netStop') }}</button>
      <button v-else type="button" class="btn btn-primary" @click="run"><AppIcon name="gauge" />{{ result ? t('system.netAgain') : t('system.netRun') }}</button>
    </div>
  </section>
</template>

<style scoped>
.res-row.active > span:first-child {
  color: var(--accent);
}

.bar {
  height: 4px;
  margin-top: 4px;
  border-radius: 2px;
  background: var(--accent-soft);
  overflow: hidden;
}

.bar > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent-btn);
  transition: width 0.4s ease;
}

.res-cell-foot .btn {
  align-self: flex-start;
  min-height: 36px;
  font-size: 13px;
}

/* ── Variante de Ajustes ──────────────────────────────────────────────────────────────────── */
.sec {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  container-type: inline-size;
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

/* Tres columnas cuando la TARJETA es ancha (no la pantalla): sirve a media o a toda anchura. */
@container (min-width: 480px) {
  .speed {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px 22px;
  }
}

.meter {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
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
  white-space: nowrap;
}

.meter.running .meter-head span {
  color: var(--accent);
  font-weight: 600;
}

.mbar {
  height: 10px;
  border-radius: 5px;
  background: var(--accent-soft);
  overflow: hidden;
}

.mbar span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent-btn);
  transition: width 0.4s ease;
}

.foot {
  margin-top: auto;
  display: flex;
}

.err {
  color: var(--danger);
}
</style>
