<script setup lang="ts">
/**
 * Favoritos (ADR-0027) en dos formatos:
 *  - `panel`: tarjeta del Panel con los últimos marcados y enlace a la página.
 *  - `page`: la página Favoritos, con búsqueda, tipo, orden y los que ya no están en su sitio.
 * Un toque abre la carpeta o el archivo en el visor; clic derecho o pulsación larga, más acciones.
 * Orden personalizado: arrastrar con el ratón, o mantener pulsado y mover el dedo (como en la
 * pantalla de inicio del móvil: el menú se abre y, al mover, se cierra y empieza el arrastre).
 */
import type { FavoriteEntry } from '@pcloud/contracts';

const props = withDefaults(defineProps<{ mode?: 'panel' | 'page'; limit?: number }>(), { mode: 'panel', limit: 12 });

const favorites = useFavorites();
const storage = useStorage();
const broken = ref<Set<string>>(new Set());
/** Imágenes cuya miniatura no pudo generar el servidor: se muestran tal cual (si son pequeñas). */
const direct = ref<Set<string>>(new Set());

onMounted(() => {
  // Al entrar se vuelve a mirar en el disco (tamaños, fechas y si siguen existiendo).
  if (favorites.loaded.value) void favorites.refresh();
  else favorites.ensure();
});
watch(storage.readable, (now, before) => {
  if (now && !before) void favorites.refresh();
});

// v2: llegó el orden personalizado, que pasa a ser el de partida.
const SORT_KEY = 'pcloud.favorites.prefs.v2';
type SortKey = 'custom' | 'added' | 'name' | 'modified';
const query = ref('');
const kind = ref<'all' | 'dir' | 'file'>('all');
const sortKey = ref<SortKey>('custom');
try {
  const saved = JSON.parse(localStorage.getItem(SORT_KEY) ?? '{}') as Partial<{ sort: string; kind: string }>;
  if (saved.sort === 'custom' || saved.sort === 'added' || saved.sort === 'name' || saved.sort === 'modified') sortKey.value = saved.sort;
  if (saved.kind === 'all' || saved.kind === 'dir' || saved.kind === 'file') kind.value = saved.kind;
} catch {
  // Sin almacenamiento: valores por defecto.
}
watch([sortKey, kind], () => {
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify({ sort: sortKey.value, kind: kind.value }));
  } catch {
    // ignorar
  }
});

const fold = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
/** Los que están en su sitio (o el disco no se puede leer ahora y no se sabe). */
const present = computed(() => favorites.entries.value.filter((entry) => entry.exists !== false));
const missing = computed(() => favorites.entries.value.filter((entry) => entry.exists === false));
const diskUnknown = computed(() => favorites.entries.value.some((entry) => entry.exists === null));

/** Ordena según el criterio elegido; «custom» es el orden en que llegan (el guardado). */
function sortList(list: readonly FavoriteEntry[], key: SortKey): FavoriteEntry[] {
  const names = collator();
  if (key === 'name') return [...list].sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : names.compare(a.name, b.name)));
  if (key === 'modified') return [...list].sort((a, b) => (b.mtime ?? '').localeCompare(a.mtime ?? ''));
  if (key === 'added') return [...list].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  return [...list];
}
const activeSort = computed<SortKey>(() => (props.mode === 'panel' ? 'custom' : sortKey.value));

const visible = computed(() => {
  if (props.mode === 'panel') return present.value.slice(0, props.limit);
  const needle = fold(query.value.trim());
  const list = present.value.filter((entry) => (kind.value === 'all' || entry.type === kind.value) && (needle === '' || fold(entry.name).includes(needle) || fold(entry.dir).includes(needle)));
  return sortList(list, sortKey.value);
});

// ── Orden personalizado ─────────────────────────────────────────────────────────────────────

/**
 * Guarda el orden nuevo de lo que se ve. Lo que no se ve (filtrado, no disponible o fuera del
 * Panel) conserva su hueco: los visibles se reparten en los huecos que ya ocupaban. Si estaba
 * ordenado por otro criterio, ese orden pasa a ser el personalizado y se selecciona.
 */
function commitOrder(newVisible: readonly string[]): void {
  const base = sortList(favorites.entries.value, activeSort.value).map((entry) => entry.path);
  const shownSet = new Set(newVisible);
  const slots = base.flatMap((p, index) => (shownSet.has(p) ? [index] : []));
  const result = [...base];
  slots.forEach((slot, index) => {
    result[slot] = newVisible[index] as string;
  });
  if (props.mode === 'page') sortKey.value = 'custom';
  void favorites.reorder(result);
}

/** «Mover antes» / «Mover después» (menú y teclado). */
function moveBy(entry: FavoriteEntry, step: -1 | 1): void {
  const order = visible.value.map((item) => item.path);
  const from = order.indexOf(entry.path);
  const to = from + step;
  if (from === -1 || to < 0 || to >= order.length) return;
  order.splice(from, 1);
  order.splice(to, 0, entry.path);
  commitOrder(order);
}

const HOLD_MS = 450;
interface Gesture {
  readonly path: string;
  readonly pointerId: number;
  readonly touch: boolean;
  readonly x0: number;
  readonly y0: number;
  readonly el: HTMLElement;
  armed: boolean;
}
let gesture: Gesture | null = null;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
/** El clic que sigue a un arrastre o a una pulsación larga no abre el elemento. */
let suppressClick = false;
/** Elemento «levantado» al mantener pulsado (antes de empezar a moverlo). */
const lifted = ref<string | null>(null);
/** Arrastre en curso: orden provisional y posición del dedo o el puntero. */
const drag = ref<{ path: string; order: string[]; x: number; y: number; dx: number; dy: number; w: number } | null>(null);
let scrollFrame = 0;

const byPath = computed(() => new Map(favorites.entries.value.map((entry) => [entry.path, entry])));
const shown = computed(() =>
  drag.value === null ? visible.value : drag.value.order.flatMap((p) => byPath.value.get(p) ?? []),
);
const dragEntry = computed(() => (drag.value === null ? null : (byPath.value.get(drag.value.path) ?? null)));

// Android abre su propio menú al mantener pulsado: mientras dura el gesto, se anula.
const swallowNative = (event: Event): void => {
  event.preventDefault();
  event.stopPropagation();
};
// Con el elemento levantado o en movimiento, el dedo no desplaza la página.
const blockScroll = (event: TouchEvent): void => {
  if ((gesture?.armed === true && gesture.touch) || drag.value !== null) event.preventDefault();
};
onMounted(() => document.addEventListener('touchmove', blockScroll, { passive: false }));
onBeforeUnmount(() => {
  document.removeEventListener('touchmove', blockScroll);
  endGesture();
});

function onPointerDown(event: PointerEvent, entry: FavoriteEntry): void {
  suppressClick = false;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  endGesture();
  const touch = event.pointerType !== 'mouse';
  gesture = { path: entry.path, pointerId: event.pointerId, touch, x0: event.clientX, y0: event.clientY, el: event.currentTarget as HTMLElement, armed: !touch };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  if (!touch) return;
  window.addEventListener('contextmenu', swallowNative, true);
  holdTimer = setTimeout(() => {
    holdTimer = null;
    if (gesture === null) return;
    gesture.armed = true;
    lifted.value = gesture.path;
    holdFinger();
    navigator.vibrate?.(12);
    openMenuFor({ x: gesture.x0, y: gesture.y0 }, menu(entry), entry.name);
  }, HOLD_MS);
}

function onPointerMove(event: PointerEvent): void {
  if (gesture === null || event.pointerId !== gesture.pointerId) return;
  if (drag.value !== null) {
    updateDrag(event.clientX, event.clientY);
    return;
  }
  const distance = Math.hypot(event.clientX - gesture.x0, event.clientY - gesture.y0);
  if (gesture.touch && !gesture.armed) {
    if (distance > 10) endGesture(); // desplazando la página
    return;
  }
  if (distance > (gesture.touch ? 8 : 6) && visible.value.length > 1) startDrag(event);
}

function onPointerUp(event: PointerEvent): void {
  if (gesture === null || event.pointerId !== gesture.pointerId) return;
  if (drag.value !== null) finishDrag();
  else if (gesture.touch && gesture.armed) suppressClick = true; // pulsación larga: el menú ya está abierto
  endGesture();
}

function onPointerCancel(): void {
  if (drag.value !== null) {
    drag.value = null;
    document.documentElement.classList.remove('fav-dragging');
  }
  endGesture();
}

function endGesture(): void {
  if (holdTimer !== null) clearTimeout(holdTimer);
  holdTimer = null;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
  setTimeout(() => window.removeEventListener('contextmenu', swallowNative, true), 80);
  if (gesture?.touch === true && gesture.armed) releaseFinger();
  gesture = null;
  lifted.value = null;
  cancelAnimationFrame(scrollFrame);
}

function startDrag(event: PointerEvent): void {
  if (gesture === null) return;
  closeMenu();
  const rect = gesture.el.getBoundingClientRect();
  drag.value = {
    path: gesture.path,
    order: visible.value.map((entry) => entry.path),
    x: event.clientX,
    y: event.clientY,
    dx: event.clientX - rect.left,
    dy: event.clientY - rect.top,
    w: rect.width,
  };
  lifted.value = null;
  suppressClick = true;
  document.documentElement.classList.add('fav-dragging');
  const scroll = (): void => {
    if (drag.value === null) return;
    const edge = 72;
    const y = drag.value.y;
    const speed = y < edge ? -(edge - y) / 3 : y > window.innerHeight - edge ? (y - (window.innerHeight - edge)) / 3 : 0;
    if (speed !== 0) {
      window.scrollBy(0, speed);
      updateDrag(drag.value.x, drag.value.y);
    }
    scrollFrame = requestAnimationFrame(scroll);
  };
  scrollFrame = requestAnimationFrame(scroll);
}

/** Sigue al puntero y, al pasar sobre otro favorito, el arrastrado ocupa su sitio. */
function updateDrag(x: number, y: number): void {
  const current = drag.value;
  if (current === null) return;
  current.x = x;
  current.y = y;
  const over = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-fav-cell]')?.dataset['favCell'];
  if (over === undefined || over === current.path) return;
  const from = current.order.indexOf(current.path);
  const to = current.order.indexOf(over);
  if (from === -1 || to === -1) return;
  current.order.splice(from, 1);
  current.order.splice(to, 0, current.path);
}

function finishDrag(): void {
  const current = drag.value;
  drag.value = null;
  document.documentElement.classList.remove('fav-dragging');
  if (current === null) return;
  const before = visible.value.map((entry) => entry.path);
  if (current.order.some((p, index) => p !== before[index])) commitOrder(current.order);
}

function onTileClick(entry: FavoriteEntry): void {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  open(entry);
}

const segmentsOf = (clientPath: string): string[] => clientPath.split('/').filter(Boolean);

function open(entry: FavoriteEntry): void {
  if (entry.type === 'dir') {
    void navigateTo(explorerLink(segmentsOf(entry.path)));
    return;
  }
  // Al cerrar el visor se vuelve aquí (Favoritos o el Panel).
  void navigateTo({ path: explorerLink(segmentsOf(entry.dir)), query: { ver: entry.name, volver: props.mode === 'page' ? '/favoritos' : '/panel' } });
}

/** Abre la carpeta que lo contiene con él seleccionado y destacado. */
function reveal(entry: FavoriteEntry): void {
  void navigateTo({ path: explorerLink(segmentsOf(entry.dir)), query: { sel: entry.name } });
}

function folderLabel(entry: FavoriteEntry): string {
  return segmentsOf(entry.dir).at(-1) ?? t('common.files');
}

function meta(entry: FavoriteEntry): string {
  if (entry.type === 'dir') return entry.dir === '/' ? t('common.folder') : `${t('common.folder')} · ${folderLabel(entry)}`;
  return entry.exists === true ? `${formatBytes(entry.size)} · ${folderLabel(entry)}` : folderLabel(entry);
}

function iconClass(entry: FavoriteEntry): string {
  const icon = fileKind(entry.name, entry.type).icon;
  return icon === 'folder' ? 'ico-folder' : icon === 'image' || icon === 'video' || icon === 'audio' ? 'ico-media' : 'ico-doc';
}

function showThumb(entry: FavoriteEntry): boolean {
  return entry.type === 'file' && entry.exists === true && entry.size > 0 && hasThumbnail(entry.name) && !broken.value.has(entry.path);
}

function thumbFor(entry: FavoriteEntry): string {
  return direct.value.has(entry.path) ? inlineUrl(entry.path) : thumbUrl(entry.path, 320, entry.mtime ?? '');
}

function onThumbError(entry: FavoriteEntry): void {
  if (!direct.value.has(entry.path) && isNativeImage(entry.name) && entry.size <= 8 * 1024 * 1024) {
    direct.value = new Set([...direct.value, entry.path]);
  } else {
    broken.value = new Set([...broken.value, entry.path]);
  }
}

const unfavorite = (list: readonly FavoriteEntry[]): void => void favorites.remove(list.map((entry) => ({ path: entry.path, type: entry.type })));

async function copyLink(entry: FavoriteEntry): Promise<void> {
  let url = `${window.location.origin}${explorerLink(segmentsOf(entry.type === 'dir' ? entry.path : entry.dir))}`;
  if (entry.type === 'file') url += `?ver=${encodeURIComponent(entry.name)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(t('explorer.linkCopied'), { tone: 'ok' });
  } catch {
    toast(t('explorer.linkCopyFailed'), { tone: 'danger' });
  }
}

function menu(entry: FavoriteEntry): MenuItem[] {
  return [
    { label: entry.type === 'dir' ? t('favorites.openFolder') : VIEWER_LABEL[viewerKind(entry.name)], icon: entry.type === 'dir' ? 'folder' : 'eye', run: () => open(entry) },
    { label: t('favorites.openNamed', { name: folderLabel(entry) }), icon: 'folder', run: () => reveal(entry) },
    {
      label: entry.type === 'dir' ? t('favorites.downloadZip') : t('favorites.download'),
      icon: entry.type === 'dir' ? 'archive' : 'download',
      separator: true,
      disabled: entry.exists !== true,
      run: () => startDownload(entry.type === 'dir' ? zipUrl(entry.dir, [entry.name]) : downloadUrl(entry.path), entry.type === 'dir' ? zipName(entry.name) : entry.name),
    },
    { label: t('explorer.copyLink'), icon: 'link', run: () => void copyLink(entry) },
    ...(visible.value.length > 1
      ? [
          { label: t('favorites.moveEarlier'), icon: 'chevron-left' as const, separator: true, disabled: visible.value[0]?.path === entry.path, run: () => moveBy(entry, -1) },
          { label: t('favorites.moveLater'), icon: 'chevron' as const, disabled: visible.value.at(-1)?.path === entry.path, run: () => moveBy(entry, 1) },
        ]
      : []),
    { label: t('favorites.remove'), icon: 'star-off', separator: true, run: () => unfavorite([entry]) },
  ];
}


const titleId = `t-favoritos-${props.mode}`;
</script>

<template>
  <section :aria-labelledby="titleId" class="favs" :class="[`mode-${mode}`, { card: mode === 'panel' }]">
    <div v-if="mode === 'panel'" class="title">
      <AppIcon name="star" :size="20" class="muted" />
      <h2 :id="titleId">{{ t('favorites.title') }}</h2>
      <NuxtLink v-if="favorites.entries.value.length > 0" to="/favoritos" class="all">{{ t('favorites.seeAllCount', { n: favorites.entries.value.length }) }}<AppIcon name="chevron" :size="14" /></NuxtLink>
    </div>
    <h2 v-else :id="titleId" class="sr-only">{{ t('favorites.title') }}</h2>

    <div v-if="mode === 'page' && present.length > 0" class="tools">
      <label class="search" :class="{ active: query !== '' }">
        <AppIcon name="search" :size="17" class="muted" />
        <span class="sr-only">{{ t('favorites.searchLabel') }}</span>
        <input v-model="query" type="search" :placeholder="t('favorites.searchPlaceholder')" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" @keydown.escape="query = ''">
      </label>
      <div class="seg" role="group" :aria-label="t('favorites.kindLabel')">
        <button type="button" :aria-pressed="kind === 'all'" :class="{ on: kind === 'all' }" @click="kind = 'all'">{{ t('favorites.kindAll') }}</button>
        <button type="button" :aria-pressed="kind === 'dir'" :class="{ on: kind === 'dir' }" @click="kind = 'dir'">{{ t('favorites.kindDirs') }}</button>
        <button type="button" :aria-pressed="kind === 'file'" :class="{ on: kind === 'file' }" @click="kind = 'file'">{{ t('favorites.kindFiles') }}</button>
      </div>
      <label for="orden-favoritos" class="sr-only">{{ t('favorites.sortLabel') }}</label>
      <select id="orden-favoritos" v-model="sortKey" class="input select">
        <option value="custom">{{ t('favorites.sortCustom') }}</option>
        <option value="added">{{ t('favorites.sortAdded') }}</option>
        <option value="name">{{ t('favorites.sortName') }}</option>
        <option value="modified">{{ t('favorites.sortModified') }}</option>
      </select>
    </div>

    <p v-if="diskUnknown" class="notice notice-warn"><AppIcon name="alert" /><span>{{ t('favorites.diskUnknown') }}</span></p>

    <ul v-if="!favorites.loaded.value && !favorites.failed.value" class="grid" aria-hidden="true">
      <li v-for="n in mode === 'panel' ? 6 : 12" :key="n" class="tile skeleton"><span class="thumb" /><span class="line" /><span class="line short" /></li>
    </ul>
    <p v-else-if="favorites.failed.value" class="muted">{{ t('favorites.loadFailed') }}</p>
    <div v-else-if="present.length === 0 && missing.length === 0" class="empty">
      <AppIcon name="star" :size="32" :stroke="1.5" class="muted" />
      <p class="empty-title">{{ t('favorites.empty') }}</p>
      <p class="muted">{{ t('favorites.emptyHint') }}</p>
      <NuxtLink to="/archivos" class="btn">{{ t('favorites.goToFiles') }}</NuxtLink>
    </div>
    <template v-else>
      <p v-if="present.length === 0" class="muted">{{ t('favorites.allUnavailable') }}</p>
      <p v-else-if="visible.length === 0" class="muted">{{ t('favorites.noMatch') }}</p>
      <TransitionGroup v-else tag="ul" name="fav-move" class="grid" :class="{ sorting: drag !== null }">
        <li
          v-for="entry in shown"
          :key="entry.path"
          class="cell"
          :class="{ placeholder: drag?.path === entry.path, lifted: lifted === entry.path }"
          :data-fav-cell="entry.path"
        >
          <button
            type="button"
            class="tile"
            :class="{ unknown: entry.exists === null }"
            :data-fav="entry.path"
            :title="entry.path"
            @pointerdown="onPointerDown($event, entry)"
            @click="onTileClick(entry)"
            @contextmenu.prevent="openMenuFor($event, menu(entry), entry.name)"
            @keydown.alt.up.prevent="moveBy(entry, -1)"
            @keydown.alt.left.prevent="moveBy(entry, -1)"
            @keydown.alt.down.prevent="moveBy(entry, 1)"
            @keydown.alt.right.prevent="moveBy(entry, 1)"
          >
            <span class="thumb">
              <img v-if="showThumb(entry)" :src="thumbFor(entry)" alt="" loading="lazy" decoding="async" draggable="false" @error="onThumbError(entry)">
              <DbsFolderIcon v-else-if="entry.type === 'dir' && entry.path.toLowerCase() === `/${BACKUP_STUDIO_FOLDER.toLowerCase()}`" :size="40" />
              <AppIcon v-else :name="fileKind(entry.name, entry.type).icon" :size="38" :stroke="1.4" :class="iconClass(entry)" />
              <span v-if="entry.type === 'file' && viewerKind(entry.name) === 'video' && showThumb(entry)" class="badge" aria-hidden="true"><AppIcon name="play" :size="12" /></span>
            </span>
            <span class="name">{{ entry.name }}</span>
            <span class="meta muted">{{ meta(entry) }}</span>
          </button>
          <button type="button" class="unstar" :aria-label="t('favorites.removeNamed', { name: entry.name })" :title="t('favorites.remove')" @click="unfavorite([entry])">
            <AppIcon name="star-filled" :size="15" />
          </button>
        </li>
      </TransitionGroup>

      <!-- Lo que se arrastra sigue al dedo o al puntero; en la cuadrícula queda su hueco. -->
      <Teleport to="body">
        <div
          v-if="drag !== null && dragEntry !== null"
          class="drag-ghost"
          :style="{ left: `${drag.x - drag.dx}px`, top: `${drag.y - drag.dy}px`, width: `${drag.w}px` }"
          aria-hidden="true"
        >
          <span class="thumb">
            <img v-if="showThumb(dragEntry)" :src="thumbFor(dragEntry)" alt="" draggable="false">
            <AppIcon v-else :name="fileKind(dragEntry.name, dragEntry.type).icon" :size="38" :stroke="1.4" :class="iconClass(dragEntry)" />
          </span>
          <span class="name">{{ dragEntry.name }}</span>
        </div>
      </Teleport>

      <p v-if="mode === 'page' && present.length > 0" class="muted foot">
        {{ t('favorites.count', { n: favorites.entries.value.length, max: favorites.max.value }) }}<template v-if="visible.length > 1"> · {{ t('favorites.reorderHint') }}</template>
      </p>
      <NuxtLink v-if="mode === 'panel' && missing.length > 0" to="/favoritos#no-disponibles" class="missing-link">{{ t('favorites.unavailableCount', { n: missing.length }) }}</NuxtLink>

      <section v-if="mode === 'page' && missing.length > 0" id="no-disponibles" aria-labelledby="t-no-disponibles" class="card gone">
        <div class="gone-head">
          <AppIcon name="alert" :size="18" class="warn" />
          <h3 id="t-no-disponibles">{{ t('favorites.unavailableTitle', { n: missing.length }) }}</h3>
          <button type="button" class="btn" @click="unfavorite(missing)"><AppIcon name="star-off" />{{ t('favorites.removeUnavailable') }}</button>
        </div>
        <p class="muted">{{ t('favorites.unavailableHint') }}</p>
        <ul class="gone-list">
          <li v-for="entry in missing" :key="entry.path">
            <AppIcon :name="fileKind(entry.name, entry.type).icon" :size="20" class="muted" />
            <span class="gone-text">
              <span class="name">{{ entry.name }}</span>
              <span class="muted mono path">{{ entry.path }}</span>
            </span>
            <button type="button" class="btn btn-icon" :aria-label="t('favorites.removeNamed', { name: entry.name })" :title="t('favorites.remove')" @click="unfavorite([entry])"><AppIcon name="close" /></button>
          </li>
        </ul>
        <NuxtLink to="/papelera" class="trash-link">{{ t('favorites.openTrash') }}<AppIcon name="chevron" :size="14" /></NuxtLink>
      </section>
    </template>
  </section>
</template>

<style scoped>
.favs {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.favs.card {
  padding: 18px;
}

.title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.title h2 {
  font-size: 15px;
  font-weight: 600;
}

.all {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
}

.tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.search {
  flex: 1 1 240px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.search:focus-within {
  border-color: var(--accent);
  outline: 2px solid var(--accent-soft);
}

.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  color: inherit;
  font: inherit;
}

.tools .select {
  flex: 0 0 auto;
  width: auto;
}

.seg {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.seg button {
  min-height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 7px;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.seg button.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.seg button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}

.mode-page .grid {
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 16px;
}

.cell {
  position: relative;
  min-width: 0;
}

.tile {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  border-radius: 12px;
  color: inherit;
}

.tile:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

/* Mantener pulsado no selecciona texto ni abre el menú de imagen del sistema (iOS). */
.tile {
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

/* Al mantener pulsado, el elemento se «levanta» antes de moverlo. */
.cell.lifted .thumb {
  transform: scale(1.05);
  box-shadow: var(--shadow);
}

/* Hueco que deja lo que se arrastra. */
.cell.placeholder .tile {
  opacity: 0.35;
}

.cell.placeholder .thumb {
  outline: 2px dashed var(--accent);
  outline-offset: 2px;
}

.grid.sorting .tile:hover .thumb {
  transform: none;
  box-shadow: none;
}

.fav-move-move {
  transition: transform 0.22s ease;
}

.drag-ghost {
  position: fixed;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: none;
  transform: rotate(-2deg) scale(1.06);
  opacity: 0.95;
}

.drag-ghost .thumb {
  box-shadow: var(--shadow);
  border-color: var(--accent);
}

.drag-ghost .name {
  padding: 0 2px;
  text-shadow: 0 1px 2px var(--bg);
}

.tile.unknown {
  opacity: 0.7;
}

.thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  border-radius: 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  overflow: hidden;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.tile:hover .thumb {
  transform: translateY(-2px);
  box-shadow: var(--shadow);
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.badge {
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: inline-flex;
  padding: 5px;
  border-radius: 50%;
  background: rgb(0 0 0 / 55%);
  color: #ffffff;
}

/* Quitar de favoritos: la estrella de la esquina (fuera del botón de la tarjeta). */
.unstar {
  position: absolute;
  top: 6px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgb(0 0 0 / 55%);
  color: #ffc23d;
  cursor: pointer;
  transition: transform 0.12s ease;
}

.unstar:hover {
  transform: scale(1.1);
}

.unstar:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.name {
  font-weight: 500;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 18px;
  text-align: center;
}

.mode-page .empty {
  padding: 48px 18px;
}

.empty-title {
  font-weight: 600;
}

.empty .muted {
  max-width: 460px;
}

.foot {
  font-size: 12.5px;
}

.missing-link {
  align-self: flex-start;
  font-size: 13px;
  font-weight: 500;
}

.gone {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.gone-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
}

.gone-head h3 {
  font-size: 15px;
  font-weight: 600;
}

.gone-head .btn {
  margin-left: auto;
}

.warn {
  color: var(--warn);
}

.gone-list {
  display: flex;
  flex-direction: column;
}

.gone-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}

.gone-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.path {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trash-link {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
}

.skeleton .thumb,
.skeleton .line {
  background: var(--surface-2);
  border: 0;
  animation: pulse 1.2s ease-in-out infinite;
}

.skeleton .line {
  display: block;
  height: 10px;
  border-radius: 5px;
  margin-top: 6px;
}

.skeleton .line.short {
  width: 60%;
}

@keyframes pulse {
  50% {
    opacity: 0.55;
  }
}

@media (max-width: 640px) {
  .grid,
  .mode-page .grid {
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 10px;
  }

  .unstar {
    width: 26px;
    height: 26px;
    top: 4px;
    right: 4px;
  }

  .seg {
    flex: 1;
  }

  .seg button {
    flex: 1;
  }
}

@media (pointer: coarse) {
  .tile:hover .thumb {
    transform: none;
    box-shadow: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .thumb,
  .unstar,
  .fav-move-move {
    transition: none;
  }

  .drag-ghost {
    transform: none;
  }
}

/* Durante un arrastre: sin selección de texto en toda la página y cursor de agarre. */
:global(html.fav-dragging),
:global(html.fav-dragging *) {
  cursor: grabbing !important;
  -webkit-user-select: none !important;
  user-select: none !important;
}
</style>
