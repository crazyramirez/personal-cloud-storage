<script setup lang="ts">
/**
 * Panel de subidas: se abre con el icono de subida de la cabecera. En ordenador es un
 * desplegable bajo el icono; en el móvil ocupa toda la pantalla. Solo muestra lo pendiente
 * (subiendo, en cola, en pausa, en espera o con error): lo terminado desaparece solo.
 */
const { pending, totals, active, panelOpen, completedTick, pauseAll, resumeAll } = useTransfers();
const panel = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
let returnFocus: HTMLElement | null = null;

const hasPaused = computed(() => pending.value.some((item) => item.state === 'paused'));
const summary = computed(() => {
  if (pending.value.length === 0) return t('transfers.summaryNone');
  if (totals.value.uploading === 0) return active.value.length > 0 ? t('transfers.stateWaiting') : t('transfers.summaryAllPaused');
  return t('transfers.summaryUploading', { n: totals.value.uploading });
});
const summaryMeta = computed(() => {
  const { size, uploaded, speed } = totals.value;
  const parts = [t('transfers.progress', { done: formatBytes(uploaded), total: formatBytes(size) })];
  if (speed > 0) parts.push(formatSpeed(speed), formatRemaining((size - uploaded) / speed));
  return parts.filter(Boolean).join(' · ');
});

function close(): void {
  panelOpen.value = false;
}

function onKey(event: KeyboardEvent): void {
  // Con un diálogo de confirmación abierto, Escape es suyo.
  if (event.key === 'Escape' && document.querySelector('dialog[open]') === null) close();
}

watch(panelOpen, async (open) => {
  if (open) {
    returnFocus = document.activeElement as HTMLElement | null;
    window.addEventListener('keydown', onKey);
    await nextTick();
    closeButton.value?.focus({ preventScroll: true });
  } else {
    window.removeEventListener('keydown', onKey);
    returnFocus?.focus?.({ preventScroll: true });
    returnFocus = null;
  }
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

// Al cambiar de página se cierra (p. ej. «Abrir carpeta de destino»), salvo al llegar desde la
// ruta antigua /transferencias, que redirige al explorador precisamente para abrirlo.
const route = useRoute();
watch(() => route.path, (_to, from) => {
  if (from !== '/transferencias') close();
});

// Fuera del panel en ordenador (en el móvil lo cubre todo y se cierra con su botón).
function onBackdrop(event: MouseEvent): void {
  if (panel.value !== null && !panel.value.contains(event.target as Node)) close();
}

// Aviso al terminar una tanda: lo terminado ya no está en la lista y así no pasa desapercibido.
let batchStart = completedTick.value;
watch(
  () => pending.value.length,
  (now, before) => {
    if (before === 0 && now > 0) batchStart = completedTick.value;
    if (before > 0 && now === 0) {
      const finished = completedTick.value - batchStart;
      if (finished > 0) toast(t('transfers.allDone', { n: finished }), { tone: 'ok' });
    }
  },
);
</script>

<template>
  <div v-if="panelOpen" class="backdrop" @mousedown="onBackdrop">
    <section ref="panel" class="panel" role="dialog" aria-labelledby="tp-title">
      <header class="head">
        <h2 id="tp-title">{{ t('transfers.title') }}</h2>
        <button v-if="active.length > 0" type="button" class="btn" @click="pauseAll"><AppIcon name="pause" :stroke="1.9" />{{ t('transfers.pauseAll') }}</button>
        <button v-else-if="hasPaused" type="button" class="btn" @click="resumeAll"><AppIcon name="play" :stroke="1.9" />{{ t('transfers.resumeAll') }}</button>
        <button ref="closeButton" type="button" class="btn btn-icon btn-ghost" :aria-label="t('transfers.close')" @click="close"><AppIcon name="close" :stroke="1.9" /></button>
      </header>

      <div v-if="pending.length > 0" class="global" :aria-label="t('transfers.globalProgress')" role="group">
        <div class="line">
          <strong>{{ summary }}</strong>
          <span class="mono muted pct">{{ totals.percent }}%</span>
        </div>
        <div class="bar" aria-hidden="true"><span :style="{ width: `${totals.percent}%` }" /></div>
        <span class="muted meta">{{ summaryMeta }}</span>
      </div>

      <ul v-if="pending.length > 0" class="rows">
        <TransferRow v-for="item in pending" :key="item.id" :transfer="item" />
      </ul>
      <div v-else class="empty">
        <span class="empty-ico"><AppIcon name="upload" :size="26" :stroke="1.8" /></span>
        <strong>{{ t('transfers.summaryNone') }}</strong>
        <p class="muted">{{ t('transfers.summaryHint') }}</p>
      </div>

      <p v-if="pending.length > 0" class="muted foot">{{ t('transfers.keepTabOpen') }}</p>
    </section>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
}

.panel {
  position: absolute;
  top: 72px;
  right: 16px;
  width: min(460px, calc(100vw - 32px));
  max-height: calc(100dvh - 88px);
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--surface);
  box-shadow: var(--shadow);
  overflow: hidden;
  animation: drop 0.14s ease-out;
}

@keyframes drop {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 10px 18px;
  border-bottom: 1px solid var(--border);
}

h2 {
  margin-right: auto;
  font-size: 16px;
  font-weight: 700;
}

.global {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.line {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.pct {
  margin-left: auto;
  font-size: 13px;
}

.meta {
  font-size: 12px;
}

.rows {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 32px 24px;
  text-align: center;
}

.empty p {
  font-size: 13px;
  max-width: 34ch;
}

.empty-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  margin-bottom: 6px;
  border-radius: 14px;
  background: var(--surface-2);
  color: var(--muted);
}

.foot {
  padding: 10px 18px 14px;
  font-size: 12px;
  border-top: 1px solid var(--border);
}

/* Móvil: pantalla completa, por encima de la barra de pestañas. */
@media (max-width: 820px) {
  .backdrop {
    background: var(--bg);
  }

  .panel {
    inset: 0;
    width: auto;
    max-height: none;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    background: var(--bg);
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    animation-name: rise;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(16px);
    }
  }

  .head {
    background: var(--surface);
    padding: 8px 8px 8px 16px;
  }

  h2 {
    font-size: 18px;
  }

  .global {
    background: var(--surface);
  }

  .empty {
    flex: 1;
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .panel {
    animation: none;
  }
}
</style>
