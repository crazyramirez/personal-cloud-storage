<script setup lang="ts">
/**
 * Favoritos (ADR-0027) en dos formatos:
 *  - `panel`: tarjeta del Panel con los últimos marcados y enlace a la página.
 *  - `page`: la página Favoritos, con búsqueda, tipo, orden y los que ya no están en su sitio.
 * Un toque abre la carpeta o el archivo en el visor; clic derecho o pulsación larga, más acciones.
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

const SORT_KEY = 'pcloud.favorites.prefs';
const query = ref('');
const kind = ref<'all' | 'dir' | 'file'>('all');
const sortKey = ref<'added' | 'name' | 'modified'>('added');
try {
  const saved = JSON.parse(localStorage.getItem(SORT_KEY) ?? '{}') as Partial<{ sort: string; kind: string }>;
  if (saved.sort === 'added' || saved.sort === 'name' || saved.sort === 'modified') sortKey.value = saved.sort;
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

const visible = computed(() => {
  if (props.mode === 'panel') return present.value.slice(0, props.limit);
  const needle = fold(query.value.trim());
  const names = collator();
  const list = present.value.filter((entry) => (kind.value === 'all' || entry.type === kind.value) && (needle === '' || fold(entry.name).includes(needle) || fold(entry.dir).includes(needle)));
  if (sortKey.value === 'name') return [...list].sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : names.compare(a.name, b.name)));
  if (sortKey.value === 'modified') return [...list].sort((a, b) => (b.mtime ?? '').localeCompare(a.mtime ?? ''));
  return list;
});

const segmentsOf = (clientPath: string): string[] => clientPath.split('/').filter(Boolean);

function open(entry: FavoriteEntry): void {
  if (entry.type === 'dir') {
    void navigateTo(explorerLink(segmentsOf(entry.path)));
    return;
  }
  void navigateTo({ path: explorerLink(segmentsOf(entry.dir)), query: { ver: entry.name } });
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
    { label: t('favorites.openNamed', { name: folderLabel(entry) }), icon: 'folder', run: () => void navigateTo(explorerLink(segmentsOf(entry.dir))) },
    {
      label: entry.type === 'dir' ? t('favorites.downloadZip') : t('favorites.download'),
      icon: entry.type === 'dir' ? 'archive' : 'download',
      separator: true,
      disabled: entry.exists !== true,
      run: () => startDownload(entry.type === 'dir' ? zipUrl(entry.dir, [entry.name]) : downloadUrl(entry.path), entry.type === 'dir' ? zipName(entry.name) : entry.name),
    },
    { label: t('explorer.copyLink'), icon: 'link', run: () => void copyLink(entry) },
    { label: t('favorites.remove'), icon: 'star-off', separator: true, run: () => unfavorite([entry]) },
  ];
}

const longPress = useLongPress((point) => {
  const target = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('[data-fav]');
  const entry = favorites.entries.value.find((item) => item.path === target?.dataset['fav']);
  if (entry !== undefined) openMenuFor(point, menu(entry), entry.name);
});

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
      <ul
        v-else
        class="grid"
        @touchstart.passive="longPress.onTouchstart"
        @touchmove.passive="longPress.onTouchmove"
        @touchend="longPress.onTouchend"
        @touchcancel="longPress.onTouchcancel"
      >
        <li v-for="entry in visible" :key="entry.path" class="cell">
          <button
            type="button"
            class="tile"
            :class="{ unknown: entry.exists === null }"
            :data-fav="entry.path"
            :title="entry.path"
            @click="longPress.wasLong() || open(entry)"
            @contextmenu.prevent="openMenuFor($event, menu(entry), entry.name)"
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
      </ul>

      <p v-if="mode === 'page' && present.length > 0" class="muted foot">{{ t('favorites.count', { n: favorites.entries.value.length, max: favorites.max.value }) }}</p>
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
  .unstar {
    transition: none;
  }
}
</style>
