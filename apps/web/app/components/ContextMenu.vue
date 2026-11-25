<script setup lang="ts">
/**
 * Menú contextual único de la aplicación (ARIA «menu»). Se coloca dentro de la ventana,
 * se maneja con flechas, Inicio/Fin, Intro y Escape, y se cierra al hacer clic fuera,
 * al desplazar o al cambiar el tamaño de la ventana.
 */
const { menu } = useMenuState();
const root = ref<HTMLElement | null>(null);
const position = ref({ left: 0, top: 0 });
const active = ref(-1);
/** En pantallas táctiles estrechas el menú es una hoja de acciones inferior (nativo). */
const sheet = ref(false);

const enabledIndexes = computed(() => (menu.value?.items ?? []).map((item, index) => (item.disabled === true ? -1 : index)).filter((index) => index >= 0));

watch(menu, async (state) => {
  if (state === null) return;
  active.value = -1;
  dragY.value = 0;
  dragging.value = false;
  position.value = { left: state.x, top: state.y };
  sheet.value = window.matchMedia('(max-width: 640px) and (pointer: coarse)').matches;
  await nextTick();
  if (sheet.value) {
    root.value?.focus({ preventScroll: true });
    return;
  }
  const el = root.value;
  if (el === null) return;
  // Tamaño sin la animación de entrada (que lo escala): offsetWidth/offsetHeight.
  const rect = { width: el.offsetWidth, height: el.offsetHeight };
  // Separación mínima con los bordes de la ventana (a la derecha suele estar el botón «⋯»).
  const margin = 16;
  let left = state.anchorRight === true ? state.x - rect.width : state.x;
  let top = state.y;
  if (left + rect.width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - rect.width - margin);
  if (left < margin) left = margin;
  if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, state.y - rect.height);
  if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - rect.height - margin);
  position.value = { left, top };
  el.focus({ preventScroll: true });
});

function choose(index: number): void {
  if (menuTouchGuard()) return; // el dedo que abrió el menú aún no se ha levantado
  const item = menu.value?.items[index];
  if (item === undefined || item.disabled === true) return;
  closeMenu();
  item.run?.();
}

function move(step: number): void {
  const list = enabledIndexes.value;
  if (list.length === 0) return;
  const at = list.indexOf(active.value);
  const next = at === -1 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length;
  active.value = list[next] as number;
  root.value?.querySelector<HTMLElement>(`[data-index="${active.value}"]`)?.focus({ preventScroll: true });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') move(1);
  else if (event.key === 'ArrowUp') move(-1);
  else if (event.key === 'Home') {
    active.value = -1;
    move(1);
  } else if (event.key === 'End') {
    active.value = -1;
    move(-1);
  } else if (event.key === 'Escape' || event.key === 'Tab') closeMenu();
  else if ((event.key === 'Enter' || event.key === ' ') && active.value >= 0) choose(active.value);
  else return;
  event.preventDefault();
  event.stopPropagation();
}

function onOutside(event: Event): void {
  // La hoja de acciones tiene su propio fondo, que se queda el toque (ver onBackdrop).
  if (sheet.value) return;
  if (menu.value !== null && root.value !== null && !root.value.contains(event.target as Node)) closeMenu();
}

/**
 * Fondo de la hoja de acciones: se cierra con el CLIC (no al apoyar el dedo), así el toque termina
 * en el fondo y nunca llega a lo que hay detrás (otra fila, una pestaña, el botón de subir).
 */
function onBackdrop(): void {
  if (menuTouchGuard()) return; // el dedo que abrió el menú aún no se ha levantado
  closeMenu();
}

// ── Cerrar la hoja arrastrándola hacia abajo (desde la barrita o el título) ─────────────────
const dragY = ref(0);
const dragging = ref(false);
let dragStart: { y: number; at: number; pointerId: number } | null = null;

function onGrabDown(event: PointerEvent): void {
  if (!sheet.value || (event.pointerType === 'mouse' && event.button !== 0)) return;
  dragStart = { y: event.clientY, at: performance.now(), pointerId: event.pointerId };
  dragging.value = true;
  dragY.value = 0;
  try {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  } catch {
    // El puntero ya no está activo: se sigue igual, sin captura.
  }
}

function onGrabMove(event: PointerEvent): void {
  if (dragStart === null || event.pointerId !== dragStart.pointerId) return;
  // Hacia arriba apenas cede (como en iOS); hacia abajo sigue al dedo.
  const dy = event.clientY - dragStart.y;
  dragY.value = dy > 0 ? dy : dy / 6;
}

function onGrabUp(event: PointerEvent): void {
  if (dragStart === null || event.pointerId !== dragStart.pointerId) return;
  const speed = dragY.value / Math.max(1, performance.now() - dragStart.at); // px/ms
  const height = root.value?.offsetHeight ?? 400;
  dragStart = null;
  dragging.value = false;
  if (dragY.value > Math.min(120, height * 0.3) || (speed > 0.6 && dragY.value > 20)) {
    dragY.value = height; // sale por abajo y se cierra
    setTimeout(() => {
      closeMenu();
      dragY.value = 0;
    }, 180);
  } else {
    dragY.value = 0; // vuelve a su sitio
  }
}

const sheetStyle = computed(() =>
  dragY.value === 0 && !dragging.value ? undefined : { transform: `translateY(${dragY.value}px)`, transition: dragging.value ? 'none' : 'transform 0.18s ease-out' },
);

const closeQuietly = (event?: Event): void => {
  // Desplazarse DENTRO del menú (hoja de acciones larga en el móvil) no lo cierra.
  if (event?.type === 'scroll' && event.target instanceof Node && root.value?.contains(event.target) === true) return;
  if (menu.value !== null) menu.value = null;
};

const route = useRoute();
watch(() => route.fullPath, () => closeQuietly());

onMounted(() => {
  window.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', closeQuietly);
  window.addEventListener('blur', closeQuietly);
  window.addEventListener('scroll', closeQuietly, true);
});
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('resize', closeQuietly);
  window.removeEventListener('blur', closeQuietly);
  window.removeEventListener('scroll', closeQuietly, true);
});
</script>

<template>
  <div
    v-if="menu && sheet"
    class="ctx-backdrop"
    :style="dragY > 0 ? { opacity: Math.max(0, 1 - dragY / 400) } : undefined"
    aria-hidden="true"
    @pointerdown.prevent
    @touchmove.prevent
    @click="onBackdrop"
    @contextmenu.prevent
  />
  <div
    v-if="menu"
    ref="root"
    class="ctx"
    :class="{ sheet }"
    role="menu"
    :aria-label="menu.title ?? t('ui.actions')"
    tabindex="-1"
    :style="sheet ? sheetStyle : { left: `${position.left}px`, top: `${position.top}px` }"
    @keydown="onKeydown"
    @contextmenu.prevent
  >
    <div v-if="sheet" class="sheet-head" @pointerdown="onGrabDown" @pointermove="onGrabMove" @pointerup="onGrabUp" @pointercancel="onGrabUp">
      <span class="grab" aria-hidden="true" />
      <p v-if="menu.title" class="title">{{ menu.title }}</p>
    </div>
    <p v-else-if="menu.title" class="title">{{ menu.title }}</p>
    <template v-for="(item, index) in menu.items" :key="`${index}-${item.label}`">
      <div v-if="item.separator && index > 0" class="sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        class="item"
        :class="{ danger: item.danger, on: index === active }"
        :data-index="index"
        :aria-disabled="item.disabled ? 'true' : undefined"
        :title="item.disabled ? item.hint : undefined"
        tabindex="-1"
        @click="choose(index)"
        @pointerenter="active = item.disabled || menuTouchGuard() ? -1 : index"
      >
        <span class="ico"><AppIcon v-if="item.checked" name="check" :size="16" /><AppIcon v-else-if="item.icon" :name="item.icon" :size="17" /></span>
        <span class="label">{{ item.label }}</span>
        <kbd v-if="item.shortcut" class="kbd">{{ item.shortcut }}</kbd>
      </button>
    </template>
  </div>
</template>

<style scoped>
.ctx {
  position: fixed;
  z-index: 1000;
  min-width: 232px;
  max-width: min(320px, calc(100vw - 16px));
  max-height: calc(100vh - 16px);
  max-height: calc(100dvh - 16px);
  overflow-y: auto;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  outline: none;
  animation: pop 0.09s ease-out;
}

@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0.97);
  }
}

.title {
  padding: 6px 10px 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  text-align: left;
  cursor: pointer;
  outline: none;
}

.item.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.item[aria-disabled='true'] {
  color: var(--muted);
  opacity: 0.6;
  cursor: default;
}

.item.danger {
  color: var(--danger);
}

.item.danger.on {
  background: var(--danger-soft);
}

.ico {
  display: inline-flex;
  width: 18px;
  justify-content: center;
}

.label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kbd {
  font-family: inherit;
  font-size: 11px;
  color: var(--muted);
}

.sep {
  height: 1px;
  margin: 5px 6px;
  background: var(--border);
}

@media (pointer: coarse) {
  .item {
    min-height: 46px;
    font-size: 15px;
  }

  .kbd {
    display: none;
  }
}

.ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: rgb(15 18 23 / 45%);
  animation: fade 0.15s ease-out;
}

@keyframes fade {
  from {
    opacity: 0;
  }
}

.ctx.sheet {
  left: 0;
  right: 0;
  bottom: 0;
  top: auto;
  max-width: 100%;
  width: 100%;
  max-height: 75vh;
  padding: 8px 10px calc(10px + env(safe-area-inset-bottom));
  border-radius: 22px 22px 0 0;
  border-bottom: 0;
  animation: sheet-up 0.22s cubic-bezier(0.2, 0.9, 0.3, 1);
}

/* Barrita y título: se arrastran hacia abajo para cerrar. Fijos arriba si la hoja se desplaza. */
.sheet-head {
  position: sticky;
  top: -8px;
  z-index: 1;
  margin: -8px -10px 0;
  padding: 8px 10px 0;
  background: inherit;
  touch-action: none;
  cursor: grab;
}

.grab {
  display: block;
  width: 40px;
  height: 5px;
  margin: 2px auto 10px;
  border-radius: 3px;
  background: var(--border-strong);
  opacity: 0.7;
}

.ctx-backdrop {
  touch-action: none;
}

.ctx.sheet .title {
  text-align: center;
  font-size: 13px;
  padding-bottom: 8px;
}

.ctx.sheet .item {
  min-height: 52px;
  font-size: 16px;
  border-radius: 12px;
}

@keyframes sheet-up {
  from {
    transform: translateY(100%);
  }
}
</style>
