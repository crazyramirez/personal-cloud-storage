<script setup lang="ts">
/** Anfitrión único de avisos, diálogos y menú contextual (va en los layouts). */
const { toasts } = useToasts();

// Altura de los avisos visibles → --toast-lift: lo que suben el botón flotante y la barra de
// selección en el móvil para que un aviso nunca los tape (como un «snackbar» de Android).
const stack = ref<HTMLElement | null>(null);
let observer: ResizeObserver | null = null;
onMounted(() => {
  if (stack.value === null || typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver(([entry]) => {
    const height = entry?.contentRect.height ?? 0;
    document.documentElement.style.setProperty('--toast-lift', height > 0 ? `${Math.ceil(height) + 10}px` : '0px');
  });
  observer.observe(stack.value);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  document.documentElement.style.removeProperty('--toast-lift');
});
const { dialog } = useDialogState();

function settle(value: unknown): void {
  const current = dialog.value;
  dialog.value = null;
  if (current === null) return;
  (current.resolve as (result: unknown) => void)(value);
}

// Si cambia la página con un diálogo abierto, se cancela: nunca actúa sobre otra carpeta.
const route = useRoute();
watch(() => route.fullPath, () => {
  const current = dialog.value;
  if (current !== null) settle(current.kind === 'confirm' ? false : null);
});
</script>

<template>
  <ContextMenu />

  <PromptDialog v-if="dialog?.kind === 'prompt'" :options="dialog.options" @done="settle" />
  <ConfirmDialog v-else-if="dialog?.kind === 'confirm'" :options="dialog.options" @done="settle" />
  <FolderPickerDialog v-else-if="dialog?.kind === 'folder'" :options="dialog.options" @done="settle" />
  <ShareDialog v-else-if="dialog?.kind === 'share'" :options="dialog.options" @done="settle" />

  <div ref="stack" class="toasts" aria-live="polite" aria-atomic="false">
    <div v-for="item in toasts" :key="item.id" class="toast" :class="`t-${item.tone}`" role="status">
      <span v-if="item.busy" class="spinner" aria-hidden="true" />
      <AppIcon v-else :name="item.tone === 'ok' ? 'check' : item.tone === 'info' ? 'info' : 'alert'" :size="18" />
      <span class="msg">{{ item.message }}</span>
      <button v-if="item.action" type="button" class="act" @click="item.action.run(); dismissToast(item.id)">{{ item.action.label }}</button>
      <button type="button" class="x" :aria-label="t('ui.dismissToast')" @click="dismissToast(item.id)"><AppIcon name="close" :size="15" /></button>
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  z-index: 900;
  left: 50%;
  bottom: calc(92px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(520px, calc(100vw - 24px));
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 10px 14px;
  border-radius: 12px;
  background: var(--text);
  color: var(--bg);
  box-shadow: var(--shadow);
  animation: rise 0.16s ease-out;
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

.t-danger {
  background: var(--danger);
  color: #ffffff;
}

.msg {
  flex: 1;
  min-width: 0;
}

.act {
  min-height: 40px;
  border: 0;
  background: none;
  color: inherit;
  font-weight: 700;
  text-decoration: underline;
  cursor: pointer;
  padding: 0 10px;
}

.x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  min-height: 40px;
  border: 0;
  background: none;
  color: inherit;
  opacity: 0.7;
  cursor: pointer;
}

@media (max-width: 820px) {
  .toasts {
    /* Encima de la barra de pestañas (la define el layout) o del borde si no hay barra. */
    bottom: var(--toast-bottom, calc(16px + env(safe-area-inset-bottom)));
  }
}

.spinner {
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
