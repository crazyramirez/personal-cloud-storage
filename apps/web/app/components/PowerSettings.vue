<script setup lang="ts">
/** Ajustes → Reiniciar o apagar el equipo (propietario, ADR-0020). */
import type { PowerStatusResponse } from '@pcloud/contracts';

const available = ref<boolean | null>(null);
const busy = ref(false);
const transfers = useTransfers();
/** Pantalla completa mientras el equipo reinicia o se apaga. */
const phase = ref<'idle' | 'rebooting' | 'slow' | 'back' | 'poweringOff' | 'off'>('idle');
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * ¿Está instalado el agente? Si el servidor no responde (sin red, reiniciando) NO se concluye que
 * no lo esté: se reintenta. Solo un «available: false» del servidor bloquea los botones.
 */
let check: ReturnType<typeof setTimeout> | null = null;
async function loadStatus(): Promise<void> {
  try {
    available.value = (await api<PowerStatusResponse>('/system/power', { handle401: false })).available;
  } catch {
    check = setTimeout(() => void loadStatus(), 5000);
  }
}
onMounted(() => void loadStatus());
onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer);
  if (check !== null) clearTimeout(check);
});

/** ¿Responde el servidor? (sin pasar por la caché ni por la sesión). */
async function alive(): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/system/health', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Tras reiniciar: espera a que el servidor caiga y vuelva; entonces recarga la página. */
function waitForReboot(): void {
  const started = Date.now();
  let wentDown = false;
  const tick = async (): Promise<void> => {
    const up = await alive();
    if (!up) wentDown = true;
    if (up && (wentDown || Date.now() - started > 90_000)) {
      phase.value = 'back';
      timer = setTimeout(() => window.location.reload(), 1200);
      return;
    }
    if (Date.now() - started > 4 * 60_000) phase.value = 'slow';
    timer = setTimeout(() => void tick(), 3000);
  };
  timer = setTimeout(() => void tick(), 6000);
}

/** Tras apagar: cuando el servidor deja de responder, se considera apagado. */
function waitForPoweroff(): void {
  const tick = async (): Promise<void> => {
    if (!(await alive())) {
      phase.value = 'off';
      return;
    }
    timer = setTimeout(() => void tick(), 2000);
  };
  timer = setTimeout(() => void tick(), 5000);
}

async function run(action: 'reboot' | 'poweroff'): Promise<void> {
  const warning = transfers.busy.value ? ` ${t('power.transfersWarning')}` : '';
  const ok = await confirmDialog(
    action === 'reboot'
      ? { title: t('power.rebootTitle'), message: t('power.rebootMessage') + warning, confirm: t('power.rebootConfirm') }
      : { title: t('power.poweroffTitle'), message: t('power.poweroffMessage') + warning, confirm: t('power.poweroffConfirm'), danger: true },
  );
  if (!ok) return;
  busy.value = true;
  try {
    await api('/system/power', { method: 'POST', body: { action } });
    if (action === 'reboot') {
      phase.value = 'rebooting';
      waitForReboot();
    } else {
      phase.value = 'poweringOff';
      waitForPoweroff();
    }
  } catch (error) {
    toast(error instanceof ApiError ? serverText(error.message) : t('power.failed'), { tone: 'danger' });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card sec" aria-labelledby="s-power">
    <header><AppIcon name="bolt" /><h2 id="s-power">{{ t('power.title') }}</h2></header>
    <p class="muted">{{ t('power.intro') }}</p>
    <p v-if="available === false" class="notice notice-info"><AppIcon name="info" class="accent" /><span>{{ t('power.unavailable') }}</span></p>
    <div class="actions">
      <button type="button" class="btn" :disabled="busy || available !== true" @click="run('reboot')"><AppIcon name="refresh" />{{ t('power.reboot') }}</button>
      <button type="button" class="btn btn-danger" :disabled="busy || available !== true" @click="run('poweroff')"><AppIcon name="bolt" />{{ t('power.poweroff') }}</button>
    </div>
  </section>

  <Teleport to="body">
    <div v-if="phase !== 'idle'" class="power-screen" role="alertdialog" aria-modal="true" aria-labelledby="power-title" aria-live="polite">
      <div class="power-box">
        <span v-if="phase === 'rebooting' || phase === 'slow' || phase === 'poweringOff'" class="spin" aria-hidden="true" />
        <AppIcon v-else :name="phase === 'back' ? 'check' : 'bolt'" :size="32" :class="phase === 'back' ? 'ok' : 'muted'" />
        <h2 id="power-title">{{ phase === 'back' ? t('power.back') : phase === 'off' ? t('power.poweredOff') : phase === 'poweringOff' ? t('power.poweringOff') : t('power.rebooting') }}</h2>
        <p class="muted">{{ phase === 'off' || phase === 'poweringOff' ? t('power.poweredOffHint') : phase === 'slow' ? t('power.rebootSlow') : phase === 'back' ? '' : t('power.rebootingHint') }}</p>
        <button v-if="phase === 'off'" type="button" class="btn" @click="phase = 'idle'">{{ t('power.close') }}</button>
      </div>
    </div>
  </Teleport>
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

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.power-screen {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: blur(6px);
}

.power-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  max-width: 380px;
  text-align: center;
}

.power-box h2 {
  font-size: 20px;
  font-weight: 700;
}

.ok {
  color: var(--ok);
}

.spin {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 3px solid var(--accent);
  border-right-color: transparent;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
