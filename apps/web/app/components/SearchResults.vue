<script setup lang="ts">
/**
 * Resultados del cuadro de búsqueda del explorador: la carpeta abierta y todas sus subcarpetas,
 * como en el Explorador de Windows o el Finder. Cada resultado dice dónde está. Un archivo se abre
 * en el visor sin salir de la búsqueda; una carpeta se abre. «Abrir ubicación» lleva a la carpeta
 * que lo contiene con él seleccionado y destacado.
 *
 * La búsqueda la hace el servidor (sin índice: recorre el árbol bajo demanda). Escribir de nuevo
 * cancela la anterior, también en el servidor.
 */
import type { BatchResponse, FsEntry, FsSearchResponse, FsSearchResult } from '@pcloud/contracts';

const props = defineProps<{
  dir: string;
  dirName: string;
  query: string;
  onlyFavorites: boolean;
  sortKey: 'name' | 'date' | 'size' | 'type';
  sortDesc: boolean;
}>();

const favorites = useFavorites();
const results = ref<FsSearchResult[]>([]);
/** Búsqueda (carpeta + texto) a la que corresponden los resultados mostrados. */
const shownFor = ref('');
const searching = ref(false);
const failed = ref<string | null>(null);
const truncated = ref<FsSearchResponse['truncated']>(null);
/** Índice de nombres del servidor (ADR-0029): mientras se genera, la búsqueda puede ser parcial. */
const indexInfo = ref<FsSearchResponse['index'] | null>(null);
const rowsEl = ref<HTMLElement | null>(null);
const broken = ref<Set<string>>(new Set());

const DEBOUNCE_MS = 250;
let timer: ReturnType<typeof setTimeout> | null = null;
let controller: AbortController | null = null;
const keyOf = (): string => `${props.dir}\u0000${props.query.trim()}`;

async function run(): Promise<void> {
  controller?.abort();
  const q = props.query.trim();
  if (q === '') return;
  const key = keyOf();
  const current = new AbortController();
  controller = current;
  searching.value = true;
  failed.value = null;
  try {
    const response = await api<FsSearchResponse>('/fs/search', { query: { path: props.dir, q }, signal: current.signal, timeoutMs: 60_000 });
    if (controller !== current) return;
    results.value = response.results;
    truncated.value = response.truncated;
    indexInfo.value = response.index;
    shownFor.value = key;
  } catch (error) {
    if (controller !== current || current.signal.aborted) return;
    failed.value = error instanceof ApiError ? error.message : t('search.failed');
    results.value = [];
    shownFor.value = key;
  } finally {
    if (controller === current) {
      searching.value = false;
      controller = null;
    }
  }
}

function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void run();
  }, DEBOUNCE_MS);
}
watch(() => [props.dir, props.query.trim()], schedule, { immediate: true });
onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer);
  controller?.abort();
});

/** Mientras llega la búsqueda nueva se siguen viendo los resultados anteriores, atenuados. */
const stale = computed(() => shownFor.value !== keyOf());

const sorted = computed(() => {
  const names = collator();
  const dir = props.sortDesc ? -1 : 1;
  const list = props.onlyFavorites ? results.value.filter((item) => favorites.isFavorite(item.path)) : results.value;
  return [...list].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    let result = 0;
    if (props.sortKey === 'date') result = a.mtime.localeCompare(b.mtime);
    else if (props.sortKey === 'size') result = a.size - b.size;
    else if (props.sortKey === 'type') result = names.compare(extensionOf(a.name), extensionOf(b.name));
    return (result || names.compare(a.name, b.name)) * dir;
  });
});

const segmentsOf = (clientPath: string): string[] => clientPath.split('/').filter(Boolean);

/** Ubicación relativa a la carpeta de la búsqueda: «En esta carpeta» o «En Fotos › Viaje». */
function location(item: FsSearchResult): string {
  if (item.dir === props.dir) return t('search.inThisFolder');
  const base = segmentsOf(props.dir).length;
  const rel = segmentsOf(item.dir).slice(base);
  return t('search.location', { path: rel.join(' › ') });
}

/** Partes del nombre con la primera coincidencia resaltada (si se encuentra tal cual). */
function highlight(name: string): Array<{ text: string; hit: boolean }> {
  const words = props.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const lower = name.toLowerCase();
  for (const word of words) {
    const at = lower.indexOf(word);
    if (at !== -1) {
      return [
        { text: name.slice(0, at), hit: false },
        { text: name.slice(at, at + word.length), hit: true },
        { text: name.slice(at + word.length), hit: false },
      ].filter((part) => part.text !== '');
    }
  }
  return [{ text: name, hit: false }];
}

function iconClass(item: FsSearchResult): string {
  const icon = fileKind(item.name, item.type).icon;
  return icon === 'folder' ? 'ico-folder' : icon === 'image' || icon === 'video' || icon === 'audio' ? 'ico-media' : 'ico-doc';
}

const showThumb = (item: FsSearchResult): boolean => item.type === 'file' && item.size > 0 && hasThumbnail(item.name) && !broken.value.has(item.path);

// ── Visor sin salir de la búsqueda ──────────────────────────────────────────────────────────

const viewer = ref<{ dir: string; name: string } | null>(null);
/** Archivos de la misma carpeta entre los resultados: se recorren con ← → en el visor. */
const viewerItems = computed<FsEntry[]>(() =>
  viewer.value === null
    ? []
    : sorted.value
        .filter((item) => item.type === 'file' && item.dir === viewer.value?.dir)
        .map((item) => ({ name: item.name, type: 'file', size: item.size, mtime: item.mtime, portable: true })),
);
const viewerIndex = computed(() => (viewer.value === null ? -1 : viewerItems.value.findIndex((item) => item.name === viewer.value?.name)));

function open(item: FsSearchResult): void {
  if (item.type === 'dir') {
    void navigateTo(explorerLink(segmentsOf(item.path)));
    return;
  }
  viewer.value = { dir: item.dir, name: item.name };
}

function closeViewer(): void {
  const current = viewer.value;
  viewer.value = null;
  if (current === null) return;
  const path = current.dir === '/' ? `/${current.name}` : `${current.dir}/${current.name}`;
  void nextTick(() => rowsEl.value?.querySelector<HTMLElement>(`[data-result="${CSS.escape(path)}"]`)?.focus());
}

function openLocation(item: FsSearchResult): void {
  void navigateTo({ path: explorerLink(segmentsOf(item.dir)), query: { sel: item.name } });
}

async function trashFromViewer(entry: FsEntry): Promise<void> {
  if (viewer.value === null) return;
  const path = viewer.value.dir === '/' ? `/${entry.name}` : `${viewer.value.dir}/${entry.name}`;
  try {
    const response = await api<BatchResponse>('/fs/trash', { method: 'POST', body: { paths: [path] }, timeoutMs: 0 });
    const done = response.results[0];
    if (done === undefined || !done.ok) {
      toast(done !== undefined && !done.ok ? localizeServerError(done.code, done.message) : t('search.failed'), { tone: 'danger' });
      return;
    }
    const id = done.path.startsWith('trash:') ? done.path.slice(6) : null;
    toast(t('explorer.trashed', { n: 1, name: entry.name }), {
      tone: 'ok',
      ...(id === null ? {} : { action: { label: t('explorer.undo'), run: () => void api('/trash/restore', { method: 'POST', body: { ids: [id] } }).then(run) } }),
    });
    // Como en la carpeta: se pasa al archivo siguiente.
    const remaining = viewerItems.value.filter((item) => item.name !== entry.name);
    const at = Math.min(Math.max(0, viewerIndex.value), remaining.length - 1);
    viewer.value = remaining[at] === undefined ? null : { dir: viewer.value.dir, name: remaining[at].name };
    results.value = results.value.filter((item) => item.path !== path);
    void favorites.refresh();
  } catch (error) {
    toast(error instanceof ApiError ? error.message : t('search.failed'), { tone: 'danger' });
  }
}

// ── Menú ────────────────────────────────────────────────────────────────────────────────────

async function copyLink(item: FsSearchResult): Promise<void> {
  let url = `${window.location.origin}${explorerLink(segmentsOf(item.type === 'dir' ? item.path : item.dir))}`;
  if (item.type === 'file') url += `?ver=${encodeURIComponent(item.name)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(t('explorer.linkCopied'), { tone: 'ok' });
  } catch {
    toast(t('explorer.linkCopyFailed'), { tone: 'danger' });
  }
}

function menu(item: FsSearchResult): MenuItem[] {
  const fav = favorites.isFavorite(item.path);
  return [
    { label: item.type === 'dir' ? t('explorer.open') : VIEWER_LABEL[viewerKind(item.name)], icon: item.type === 'dir' ? 'folder' : 'eye', run: () => open(item) },
    { label: t('search.openLocation'), icon: 'folder', run: () => openLocation(item) },
    {
      label: item.type === 'dir' ? t('explorer.downloadAsZip') : t('explorer.download'),
      icon: item.type === 'dir' ? 'archive' : 'download',
      separator: true,
      run: () => startDownload(item.type === 'dir' ? zipUrl(item.dir, [item.name]) : downloadUrl(item.path), item.type === 'dir' ? zipName(item.name) : item.name),
    },
    { label: t('explorer.copyLink'), icon: 'link', run: () => void copyLink(item) },
    { label: fav ? t('favorites.remove') : t('favorites.add'), icon: fav ? 'star-off' : 'star', run: () => void favorites.toggle([{ path: item.path, type: item.type }]) },
  ];
}

const longPress = useLongPress((point) => {
  const target = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('[data-result]');
  const item = results.value.find((entry) => entry.path === target?.dataset['result']);
  if (item !== undefined) openMenuFor(point, menu(item), item.name);
});

// ── Teclado ─────────────────────────────────────────────────────────────────────────────────

function rows(): HTMLElement[] {
  return [...(rowsEl.value?.querySelectorAll<HTMLElement>('[data-result]') ?? [])];
}

/** Desde el cuadro de búsqueda, ↓ lleva al primer resultado. */
function focusFirst(): void {
  rows()[0]?.focus();
}
defineExpose({ focusFirst });

function onRowKey(event: KeyboardEvent, item: FsSearchResult): void {
  const list = rows();
  const at = list.indexOf(event.currentTarget as HTMLElement);
  if (event.key === 'ArrowDown') list[Math.min(list.length - 1, at + 1)]?.focus();
  else if (event.key === 'ArrowUp') {
    if (at <= 0) document.querySelector<HTMLInputElement>('.explorer .search input')?.focus();
    else list[at - 1]?.focus();
  } else if (event.key === 'Home') list[0]?.focus();
  else if (event.key === 'End') list.at(-1)?.focus();
  else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenuFor(event, menu(item), item.name);
  else return;
  event.preventDefault();
}
</script>

<template>
  <section class="listing search-results" :aria-label="t('search.results')" :aria-busy="searching">
    <div class="status" role="status">
      <span v-if="searching" class="spinner" aria-hidden="true" />
      <AppIcon v-else name="search" :size="16" class="muted" />
      <span v-if="searching && stale">{{ t('search.searching', { name: dirName }) }}</span>
      <span v-else-if="!failed">{{ t('search.count', { n: sorted.length, name: dirName }) }}</span>
      <span v-if="!failed && indexInfo?.state === 'ready' && indexInfo.builtAt" class="age" :title="formatDate(indexInfo.builtAt)">· {{ t('search.indexAge', { when: formatRelative(indexInfo.builtAt) }) }}</span>
    </div>

    <p v-if="!stale && truncated === 'limit'" class="notice notice-warn"><AppIcon name="alert" /><span>{{ t('search.truncatedLimit', { n: results.length }) }}</span></p>
    <p v-else-if="!stale && indexInfo !== null && indexInfo.state !== 'ready'" class="notice"><AppIcon name="info" /><span>{{ t('search.indexBuilding') }}</span></p>
    <p v-else-if="!stale && truncated === 'time'" class="notice notice-warn"><AppIcon name="alert" /><span>{{ t('search.truncatedTime') }}</span></p>

    <div v-if="failed && !stale" class="card empty">
      <AppIcon name="alert" :size="40" :stroke="1.4" class="muted" />
      <h2>{{ t('search.failed') }}</h2>
      <p class="muted">{{ failed }}</p>
      <button type="button" class="btn" @click="run"><AppIcon name="refresh" />{{ t('common.retry') }}</button>
    </div>

    <div v-else-if="!stale && sorted.length === 0" class="card empty">
      <AppIcon :name="onlyFavorites ? 'star' : 'search'" :size="40" :stroke="1.4" class="muted" />
      <h2>{{ onlyFavorites && results.length > 0 ? t('search.noFavorites') : t('search.none', { q: query.trim(), name: dirName }) }}</h2>
      <p class="muted">{{ t('search.noneHint') }}</p>
      <NuxtLink v-if="dir !== '/'" :to="{ path: '/archivos', query: { buscar: query.trim() } }" class="btn"><AppIcon name="search" />{{ t('search.everywhere') }}</NuxtLink>
    </div>

    <div v-else-if="sorted.length > 0" class="table" :class="{ stale }">
      <ul
        ref="rowsEl"
        @touchstart.passive="longPress.onTouchstart"
        @touchmove.passive="longPress.onTouchmove"
        @touchend="longPress.onTouchend"
        @touchcancel="longPress.onTouchcancel"
      >
        <li v-for="item in sorted" :key="item.path">
          <button
            type="button"
            class="row item"
            :data-result="item.path"
            :title="item.path"
            @click="longPress.wasLong() || open(item)"
            @contextmenu.prevent.stop="openMenuFor($event, menu(item), item.name)"
            @keydown="onRowKey($event, item)"
          >
            <span class="name">
              <span class="ico">
                <img v-if="showThumb(item)" :src="thumbUrl(item.path, 160, item.mtime)" alt="" loading="lazy" decoding="async" draggable="false" @error="broken = new Set([...broken, item.path])">
                <DbsFolderIcon v-else-if="item.type === 'dir' && item.path.toLowerCase() === `/${BACKUP_STUDIO_FOLDER.toLowerCase()}`" :size="22" />
                <AppIcon v-else :name="fileKind(item.name, item.type).icon" :size="22" :class="iconClass(item)" />
              </span>
              <span class="label">
                <span class="text"><template v-for="(part, index) in highlight(item.name)" :key="index"><mark v-if="part.hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template><AppIcon v-if="favorites.isFavorite(item.path)" name="star-filled" :size="13" class="fav-badge" /></span>
                <span class="where muted"><AppIcon name="folder" :size="12" />{{ location(item) }}</span>
              </span>
            </span>
            <span class="muted cell">{{ item.type === 'dir' ? '—' : formatBytes(item.size) }}</span>
            <span class="muted cell col-date">{{ formatDate(item.mtime) }}</span>
            <span class="dots" role="presentation" @click.stop="openMenuFor($event, menu(item), item.name)"><AppIcon name="more" /></span>
          </button>
        </li>
      </ul>
    </div>

    <FileViewer
      v-if="viewer !== null && viewerIndex >= 0"
      :items="viewerItems"
      :index="viewerIndex"
      :dir="viewer.dir"
      @close="closeViewer"
      @navigate="(index) => { if (viewer) viewer = { dir: viewer.dir, name: (viewerItems[index] as FsEntry).name }; }"
      @trash="trashFromViewer"
    />
  </section>
</template>

<style scoped>
.search-results {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  font-size: 13px;
  color: var(--muted);
}

.age {
  font-size: 12px;
}

.spinner {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.table {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
  transition: opacity 0.15s ease;
}

.table.stale {
  opacity: 0.55;
}

.table ul {
  display: flex;
  flex-direction: column;
}

.row {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 110px 180px 40px;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 14px;
  min-height: 56px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

li:last-child .row {
  border-bottom: 0;
}

.row:hover {
  background: var(--surface-2);
}

.row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: var(--accent-soft);
}

.name {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
}

.ico {
  flex: none;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  overflow: hidden;
}

.ico img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.label {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.text {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

mark {
  background: var(--fav-soft);
  color: inherit;
  border-radius: 3px;
  box-shadow: 0 0 0 1px var(--fav-border);
}

.where {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fav-badge {
  margin-left: 6px;
  vertical-align: -1px;
  color: var(--fav);
}

.cell {
  font-size: 13px;
  white-space: nowrap;
}

.dots {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  color: var(--muted);
}

.dots:hover {
  background: var(--surface);
  color: var(--text);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 18px;
  text-align: center;
}

.empty h2 {
  font-size: 16px;
  font-weight: 600;
}

.empty .muted {
  max-width: 460px;
}

@media (max-width: 900px) {
  .col-date {
    display: none;
  }

  .row {
    grid-template-columns: minmax(0, 1fr) 90px 40px;
  }
}

@media (max-width: 640px) {
  .row {
    grid-template-columns: minmax(0, 1fr) 40px;
  }

  .cell {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 2s;
  }

  .table {
    transition: none;
  }
}
</style>
