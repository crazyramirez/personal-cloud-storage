<script setup lang="ts">
/** Ajustes → Copias de tus ordenadores: código para conectar DEV Backup Studio (ADR-0022). */
import type { PairingStatusResponse } from '@pcloud/contracts';

const status = ref<PairingStatusResponse | null>(null);
const busy = ref(false);
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;
let poll: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  try {
    status.value = await api<PairingStatusResponse>('/pairing', { handle401: false });
  } catch {
    // sin red o reiniciando: se reintenta con el sondeo
  }
}

const remainingMs = computed(() => (status.value?.expiresAt ? Date.parse(status.value.expiresAt) - now.value : 0));
const active = computed(() => status.value?.code != null && remainingMs.value > 0);
const minutes = computed(() => Math.max(1, Math.ceil(remainingMs.value / 60_000)));
/** «482 913»: más fácil de leer y de dictar. */
const shown = computed(() => (status.value?.code ? `${status.value.code.slice(0, 3)} ${status.value.code.slice(3)}` : ''));

onMounted(() => {
  void load();
  tick = setInterval(() => (now.value = Date.now()), 1000);
  // Mientras se ve un código: cuando el ordenador lo usa, desaparece solo.
  poll = setInterval(() => {
    if (active.value) void load();
  }, 3000);
});
onBeforeUnmount(() => {
  if (tick !== null) clearInterval(tick);
  if (poll !== null) clearInterval(poll);
});

async function create(): Promise<void> {
  busy.value = true;
  try {
    status.value = await api<PairingStatusResponse>('/pairing/code', { method: 'POST' });
  } catch (error) {
    toast(error instanceof ApiError ? serverText(error.message) : t('pairing.failed'), { tone: 'danger' });
  } finally {
    busy.value = false;
  }
}

async function cancel(): Promise<void> {
  try {
    status.value = await api<PairingStatusResponse>('/pairing/code', { method: 'DELETE' });
  } catch {
    void load();
  }
}

async function copy(): Promise<void> {
  if (!status.value?.code) return;
  try {
    await navigator.clipboard.writeText(status.value.code);
    toast(t('pairing.copied'));
  } catch {
    // portapapeles bloqueado: el código sigue a la vista
  }
}
</script>

<template>
  <section class="card sec" aria-labelledby="s-pairing">
    <header><AppIcon name="monitor" /><h2 id="s-pairing">{{ t('pairing.title') }}</h2></header>
    <p class="muted">{{ t('pairing.intro') }}</p>

    <p v-if="status && !status.available" class="notice notice-info"><AppIcon name="info" class="accent" /><span>{{ t('pairing.unavailable') }}</span></p>

    <template v-else-if="status">
      <div v-if="active" class="pair">
        <ol class="steps">
          <li>{{ t('pairing.step1') }}</li>
          <li>{{ t('pairing.step2') }}</li>
          <li>{{ t('pairing.step3') }}</li>
        </ol>
        <button type="button" class="code" :aria-label="`${t('pairing.codeLabel')}: ${status.code}. ${t('pairing.copy')}`" :title="t('pairing.copy')" @click="copy">
          {{ shown }}
        </button>
        <p class="muted small" aria-live="polite">{{ t('pairing.expires', { min: minutes }) }}</p>
      </div>
      <p v-if="status.share" class="muted small">{{ t('pairing.where', { host: status.host, share: status.share }) }}</p>
      <div class="actions">
        <button v-if="!active" type="button" class="btn btn-primary" :disabled="busy" @click="create"><AppIcon name="link" />{{ t('pairing.connect') }}</button>
        <template v-else>
          <button type="button" class="btn" :disabled="busy" @click="create"><AppIcon name="refresh" />{{ t('pairing.newCode') }}</button>
          <button type="button" class="btn" @click="cancel"><AppIcon name="close" />{{ t('pairing.cancel') }}</button>
        </template>
      </div>
    </template>
  </section>
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

.pair {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 18px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  text-align: center;
}

.steps {
  margin: 0;
  padding-left: 1.2em;
  text-align: left;
}

.code {
  font: 700 44px/1.1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: 0.08em;
  padding: 6px 18px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--text);
  cursor: copy;
}

.code:hover,
.code:focus-visible {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
</style>
