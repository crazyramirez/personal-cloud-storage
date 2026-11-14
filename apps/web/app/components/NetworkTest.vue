<script setup lang="ts">
/**
 * Prueba de red entre ESTE dispositivo y el servidor (Wi-Fi, cable o Tailscale): latencia,
 * bajada y subida reales. Los datos salen de la memoria del servidor y la subida se descarta:
 * no se toca ningún disco. Unos 15 s en total; el último resultado se recuerda en este navegador.
 */
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
const latencyVerdict = (ms: number): string => t(ms <= 15 ? 'system.latencyGreat' : ms <= 60 ? 'system.latencyGood' : 'system.latencySlow');
const phaseLabel = computed(() => (phase.value === 'idle' ? '' : t(`system.netPhase_${phase.value}`)));
</script>

<template>
  <article class="card tile" aria-labelledby="r-nettest">
    <header>
      <span class="ico"><AppIcon name="gauge" :size="18" /></span>
      <h3 id="r-nettest">{{ t('system.netTest') }}</h3>
    </header>
    <p v-if="!result && !busy" class="muted small">{{ t('system.netTestIntro') }}</p>

    <div v-if="busy" class="running" aria-live="polite">
      <span class="muted small">{{ phaseLabel }}</span>
      <strong>{{ phase === 'latency' ? '…' : fmt(live) }}</strong>
      <div class="bar" aria-hidden="true"><span class="sweep" :style="{ width: phase === 'latency' ? '20%' : `${pct(live)}%` }" /></div>
    </div>
    <div v-else-if="result" class="rows">
      <div class="row">
        <div class="row-head"><span><AppIcon name="download" :size="13" />{{ t('system.netDown') }}</span><strong>{{ fmt(result.downMbps) }}</strong></div>
        <div class="bar" aria-hidden="true"><span :style="{ width: `${pct(result.downMbps)}%` }" /></div>
        <span class="muted small">{{ verdict(result.downMbps) }}</span>
      </div>
      <div class="row">
        <div class="row-head"><span><AppIcon name="upload" :size="13" />{{ t('system.netUp') }}</span><strong>{{ fmt(result.upMbps) }}</strong></div>
        <div class="bar" aria-hidden="true"><span :style="{ width: `${pct(result.upMbps)}%` }" /></div>
      </div>
      <div class="row-head">
        <span><AppIcon name="clock" :size="13" />{{ t('system.netLatency') }}</span>
        <strong>{{ formatNumber(result.latencyMs, result.latencyMs < 10 ? 1 : 0) }} ms <span class="muted small">· {{ latencyVerdict(result.latencyMs) }}</span></strong>
      </div>
      <p class="muted small">{{ t('system.netThisDevice') }} · {{ formatRelative(result.at) }}</p>
    </div>
    <p v-if="error" role="alert" class="notice notice-danger">{{ error }}</p>
    <div>
      <button v-if="busy" type="button" class="btn" @click="stop"><AppIcon name="close" />{{ t('system.netStop') }}</button>
      <button v-else type="button" class="btn" @click="run"><AppIcon name="gauge" />{{ result ? t('system.netAgain') : t('system.netRun') }}</button>
    </div>
  </article>
</template>

<style scoped>
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

.running {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.running strong {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.row-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
}

.row-head > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}

.row-head strong {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.bar {
  height: 6px;
  border-radius: 3px;
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
</style>
