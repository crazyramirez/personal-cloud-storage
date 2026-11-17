<script setup lang="ts">
/**
 * Panel → Recientes: lo último subido o creado que sigue existiendo. Un toque abre la carpeta
 * o el archivo directamente en el visor; clic derecho o pulsación larga para más acciones.
 */
import type { RecentEntry, RecentResponse } from '@pcloud/contracts';

const storage = useStorage();
const { completedTick } = useTransfers();
const entries = ref<RecentEntry[]>([]);
const loading = ref(true);
const failed = ref(false);
const broken = ref<Set<string>>(new Set());
/** Imágenes cuya miniatura no pudo generar el servidor: se muestran tal cual (si son pequeñas). */
const direct = ref<Set<string>>(new Set());

function thumbFor(entry: RecentEntry): string {
  return direct.value.has(entry.path) ? inlineUrl(entry.path) : thumbUrl(entry.path, 320, entry.mtime);
}

function onThumbError(entry: RecentEntry): void {
  if (!direct.value.has(entry.path) && isNativeImage(entry.name) && entry.size <= 8 * 1024 * 1024) {
    direct.value = new Set([...direct.value, entry.path]);
  } else {
    broken.value = new Set([...broken.value, entry.path]);
  }
}

function iconClass(entry: RecentEntry): string {
  const icon = fileKind(entry.name, entry.type).icon;
  return icon === 'folder' ? 'ico-folder' : icon === 'image' || icon === 'video' || icon === 'audio' ? 'ico-media' : 'ico-doc';
}
let requestId = 0;

async function load(): Promise<void> {
  const current = ++requestId;
  failed.value = false;
  try {
    const response = await api<RecentResponse>('/fs/recent', { query: { limit: 12 } });
    if (current !== requestId) return;
    entries.value = response.entries;
  } catch {
    if (current === requestId) failed.value = true;
  } finally {
    if (current === requestId) loading.value = false;
  }
}

onMounted(load);
watch(completedTick, () => void load());
watch(storage.readable, (now, before) => {
  if (now && !before) void load();
});

const segmentsOf = (clientPath: string): string[] => clientPath.split('/').filter(Boolean);

function open(entry: RecentEntry): void {
  if (entry.type === 'dir') {
    void navigateTo(explorerLink(segmentsOf(entry.path)));
    return;
  }
  void navigateTo({ path: explorerLink(segmentsOf(entry.dir)), query: { ver: entry.name } });
}

function folderLabel(entry: RecentEntry): string {
  const parent = segmentsOf(entry.dir).at(-1);
  return parent ?? t('common.files');
}

function showThumb(entry: RecentEntry): boolean {
  return entry.type === 'file' && entry.size > 0 && hasThumbnail(entry.name) && !broken.value.has(entry.path);
}

function menu(entry: RecentEntry): MenuItem[] {
  return [
    { label: entry.type === 'dir' ? t('recent.openFolder') : VIEWER_LABEL[viewerKind(entry.name)], icon: entry.type === 'dir' ? 'folder' : 'eye', run: () => open(entry) },
    ...(entry.type === 'file' ? [{ label: t('recent.openNamed', { name: folderLabel(entry) }), icon: 'folder' as const, run: () => void navigateTo(explorerLink(segmentsOf(entry.dir))) }] : []),
    {
      label: entry.type === 'dir' ? t('recent.downloadZip') : t('recent.download'),
      icon: entry.type === 'dir' ? 'archive' : 'download',
      separator: true,
      run: () => startDownload(entry.type === 'dir' ? zipUrl(entry.dir, [entry.name]) : downloadUrl(entry.path), entry.type === 'dir' ? zipName(entry.name) : entry.name),
    },
  ];
}

const longPress = useLongPress((point) => {
  const target = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('[data-recent]');
  const entry = entries.value.find((item) => item.path === target?.dataset['recent']);
  if (entry !== undefined) openMenuFor(point, menu(entry), entry.name);
});
</script>

<template>
  <section aria-labelledby="t-recientes" class="card recent">
    <div class="title">
      <AppIcon name="clock" :size="20" class="muted" />
      <h2 id="t-recientes">{{ t('recent.title') }}</h2>
      <NuxtLink to="/archivos" class="all">{{ t('recent.seeAll') }}<AppIcon name="chevron" :size="14" /></NuxtLink>
    </div>

    <ul v-if="loading" class="grid" aria-hidden="true">
      <li v-for="n in 6" :key="n" class="tile skeleton"><span class="thumb" /><span class="line" /><span class="line short" /></li>
    </ul>
    <p v-else-if="failed" class="muted">{{ t('recent.unavailable') }}</p>
    <div v-else-if="entries.length === 0" class="empty">
      <AppIcon name="upload" :size="32" :stroke="1.5" class="muted" />
      <p class="muted">{{ t('recent.empty') }}</p>
      <NuxtLink to="/archivos" class="btn">{{ t('recent.goToFiles') }}</NuxtLink>
    </div>
    <ul
      v-else
      class="grid"
      @touchstart.passive="longPress.onTouchstart"
      @touchmove.passive="longPress.onTouchmove"
      @touchend="longPress.onTouchend"
      @touchcancel="longPress.onTouchcancel"
    >
      <li v-for="entry in entries" :key="entry.path">
        <button
          type="button"
          class="tile"
          :data-recent="entry.path"
          :title="entry.path"
          @click="longPress.wasLong() || open(entry)"
          @contextmenu.prevent="openMenuFor($event, menu(entry), entry.name)"
        >
          <span class="thumb">
            <img
              v-if="showThumb(entry)"
              :src="thumbFor(entry)"
              alt=""
              loading="lazy"
              decoding="async"
              draggable="false"
              @error="onThumbError(entry)"
            >
            <DbsFolderIcon v-else-if="entry.type === 'dir' && entry.path.toLowerCase() === `/${BACKUP_STUDIO_FOLDER.toLowerCase()}`" :size="40" />
            <AppIcon v-else :name="fileKind(entry.name, entry.type).icon" :size="38" :stroke="1.4" :class="iconClass(entry)" />
            <span v-if="entry.type === 'file' && viewerKind(entry.name) === 'video' && showThumb(entry)" class="badge" aria-hidden="true"><AppIcon name="play" :size="12" /></span>
          </span>
          <span class="name">{{ entry.name }}</span>
          <span class="meta muted">{{ formatRelative(entry.at) }} · {{ folderLabel(entry) }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.recent {
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
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

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
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
  gap: 10px;
  padding: 18px;
  text-align: center;
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
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 10px;
  }
}

@media (pointer: coarse) {
  .tile:hover .thumb {
    transform: none;
    box-shadow: none;
  }
}
</style>
