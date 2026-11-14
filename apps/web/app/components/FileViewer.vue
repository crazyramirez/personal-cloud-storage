<script setup lang="ts">
/**
 * Visor a pantalla completa. Recorre los archivos de la carpeta (← →, deslizar en el móvil).
 *  - Imagen: tal cual o convertida por la Pi (HEIC, TIFF…); zoom con rueda, botones o doble toque.
 *  - Vídeo/audio: reproducción directa si el navegador puede; si no, flujo convertido por la Pi
 *    (MKV, AVI, WMV…) con su propia barra de tiempo (saltar = pedir el flujo desde ese punto).
 *  - PDF: visor del navegador. Documentos de oficina: convertidos a PDF por LibreOffice.
 *  - Texto y código: primeros 2 MB, con ajuste de línea opcional.
 */
import type { FsEntry, MediaInfoResponse } from '@pcloud/contracts';

const props = defineProps<{ items: FsEntry[]; index: number; dir: string }>();
const emit = defineEmits<{ close: []; navigate: [index: number]; trash: [entry: FsEntry] }>();

const TEXT_LIMIT = 2 * 1024 * 1024;
const root = ref<HTMLElement | null>(null);
const current = computed(() => props.items[props.index] ?? null);
const path = computed(() => (current.value === null ? '' : props.dir === '/' ? `/${current.value.name}` : `${props.dir}/${current.value.name}`));
const kind = computed<ViewerKind>(() => (current.value === null ? 'none' : viewerKind(current.value.name)));

const loading = ref(false);
const error = liveText();
const zoom = ref(1);
const text = ref('');
const textTruncated = ref(false);
const wrap = ref(true);
const docUrl = ref('');
const media = ref<MediaInfoResponse | null>(null);
const streamOffset = ref(0);
const playerTime = ref(0);
const playing = ref(false);
const player = ref<HTMLMediaElement | null>(null);
const seeking = ref(false);
/** El audio no tiene carátula incrustada: se muestra el icono. */
const coverFailed = ref(false);
const seekValue = ref(0);
const natural = ref({ width: 0, height: 0 });
const stageSize = ref({ width: 0, height: 0 });
let generation = 0;

/** Tamaño de la imagen: ajustada a la pantalla × zoom (nunca su tamaño original × zoom). */
const imageBox = computed(() => {
  const { width, height } = natural.value;
  if (width === 0 || height === 0 || stageSize.value.width === 0) return null;
  const fit = Math.min(stageSize.value.width / width, stageSize.value.height / height, 1);
  return { width: Math.round(width * fit * zoom.value), height: Math.round(height * fit * zoom.value) };
});

function onImageLoad(event: Event): void {
  const img = event.target as HTMLImageElement;
  natural.value = { width: img.naturalWidth, height: img.naturalHeight };
  measureStage();
}

function measureStage(): void {
  const stage = root.value?.querySelector('.stage');
  if (stage instanceof HTMLElement) stageSize.value = { width: stage.clientWidth - 16, height: stage.clientHeight - 16 };
}

const imageSrc = computed(() => (current.value === null ? '' : isNativeImage(current.value.name) ? inlineUrl(path.value) : convertedImageUrl(path.value)));
const streamed = computed(() => media.value !== null && (media.value.playback === 'remux' || media.value.playback === 'transcode'));
const mediaSrc = computed(() => (streamed.value ? streamUrl(path.value, streamOffset.value) : inlineUrl(path.value)));
const duration = computed(() => media.value?.duration ?? 0);
const isAudioOnly = computed(() => kind.value === 'audio' || (media.value !== null && media.value.video === null));

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

async function prepare(): Promise<void> {
  const run = ++generation;
  error.value = '';
  text.value = '';
  textTruncated.value = false;
  docUrl.value = '';
  media.value = null;
  streamOffset.value = 0;
  playerTime.value = 0;
  zoom.value = 1;
  natural.value = { width: 0, height: 0 };
  coverFailed.value = false;
  if (current.value === null) return;
  const entry = current.value;
  try {
    if (kind.value === 'text') {
      loading.value = true;
      const response = await apiResponse(`/fs/download`, { query: { path: path.value, inline: '1' }, headers: { range: `bytes=0-${TEXT_LIMIT - 1}` } });
      const buffer = await response.arrayBuffer();
      if (run !== generation) return;
      text.value = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
      textTruncated.value = entry.size > TEXT_LIMIT;
    } else if (kind.value === 'office') {
      loading.value = true;
      const url = documentPdfUrl(path.value);
      // Primero se genera (la Pi lo guarda en caché); si falla, se muestra el motivo.
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        throw new Error(body?.error?.message ? localizeServerError(body.error.code ?? '', body.error.message) : t('viewer.convertFailed'));
      }
      await response.arrayBuffer();
      if (run !== generation) return;
      docUrl.value = url;
    } else if (kind.value === 'video' || kind.value === 'audio') {
      loading.value = true;
      try {
        media.value = await api<MediaInfoResponse>('/media/info', { query: { path: path.value } });
      } catch {
        media.value = null; // sin ffmpeg: se intenta la reproducción directa
      }
      if (run !== generation) return;
      if (media.value?.playback === 'none') throw new Error(t('viewer.noPlayableMedia'));
    }
  } catch (failure) {
    if (run === generation) error.value = errorText(failure, 'viewer.openFailed');
  } finally {
    if (run === generation) loading.value = false;
  }
}

watch(path, prepare, { immediate: true });

function go(step: number): void {
  const next = props.index + step;
  if (next >= 0 && next < props.items.length) emit('navigate', next);
}

function seek(event: Event): void {
  seeking.value = false;
  const value = Number((event.target as HTMLInputElement).value);
  if (!streamed.value) {
    if (player.value !== null) player.value.currentTime = value;
    return;
  }
  streamOffset.value = value;
  playerTime.value = 0;
}

function togglePlay(): void {
  const el = player.value;
  if (el === null) return;
  if (el.paused) void el.play();
  else el.pause();
}

function onTimeUpdate(): void {
  playerTime.value = player.value?.currentTime ?? 0;
}

const shownTime = computed(() => (streamed.value ? streamOffset.value + playerTime.value : playerTime.value));

function fullscreen(): void {
  const el = root.value?.querySelector('.stage') as HTMLElement | null;
  if (document.fullscreenElement !== null) void document.exitFullscreen();
  else void el?.requestFullscreen?.();
}

function onKey(event: KeyboardEvent): void {
  if (event.target instanceof HTMLInputElement && event.target.type !== 'range') return;
  if (event.key === 'Escape') emit('close');
  else if (event.key === 'ArrowRight' && !(event.target instanceof HTMLInputElement)) go(1);
  else if (event.key === 'ArrowLeft' && !(event.target instanceof HTMLInputElement)) go(-1);
  else if (event.key === '+' || event.key === '=') zoomCenter(zoom.value * 1.25);
  else if (event.key === '-') zoomCenter(zoom.value / 1.25);
  else if (event.key === ' ' && (kind.value === 'video' || kind.value === 'audio')) togglePlay();
  else if (event.key === 'Delete' && current.value !== null) emit('trash', current.value);
  else if (event.key === 'Tab') trapFocus(event);
  else return;
  event.preventDefault();
}

/** Tab y Mayús+Tab recorren solo los controles del visor (diálogo modal). */
function trapFocus(event: KeyboardEvent): void {
  const items = [...(root.value?.querySelectorAll<HTMLElement>('button, a[href], input, video[controls], audio[controls], iframe') ?? [])].filter((el) => !el.hasAttribute('disabled'));
  if (items.length === 0) return;
  const first = items[0] as HTMLElement;
  const last = items[items.length - 1] as HTMLElement;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !root.value?.contains(active))) {
    last.focus();
  } else if (!event.shiftKey && (active === last || !root.value?.contains(active))) {
    first.focus();
  } else {
    return;
  }
  event.preventDefault();
}

// ── Zoom anclado a un punto ────────────────────────────────────────────────────────────────
// El punto de la imagen que está bajo los dedos (o el ratón) se queda bajo ellos al ampliar:
// se calcula su posición relativa en la imagen y, tras redimensionarla, se desplaza el contenedor
// para devolverlo a la misma posición de pantalla. Al pellizcar, ese punto sigue además al punto
// medio de los dedos, así que se puede ampliar y desplazar a la vez.

interface Anchor {
  /** Posición relativa (0-1) del punto dentro de la imagen. */
  fx: number;
  fy: number;
  /** Dónde debe quedar en la pantalla. */
  clientX: number;
  clientY: number;
}

function imageParts(): { wrap: HTMLElement; img: HTMLImageElement } | null {
  const wrap = root.value?.querySelector('.image-wrap');
  const img = wrap?.querySelector('img');
  return wrap instanceof HTMLElement && img instanceof HTMLImageElement ? { wrap, img } : null;
}

function anchorAt(clientX: number, clientY: number): Anchor | null {
  const parts = imageParts();
  if (parts === null) return null;
  const rect = parts.img.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  return { fx: clamp((clientX - rect.left) / rect.width), fy: clamp((clientY - rect.top) / rect.height), clientX, clientY };
}

let pendingAnchor: Anchor | null = null;
let anchorFrame = 0;

/** Tras aplicar el nuevo tamaño, desplaza para que el punto anclado quede en su sitio. */
function settleAnchor(anchor: Anchor): void {
  pendingAnchor = anchor;
  if (anchorFrame !== 0) return;
  void nextTick(() => {
    anchorFrame = requestAnimationFrame(() => {
      anchorFrame = 0;
      const target = pendingAnchor;
      pendingAnchor = null;
      const parts = imageParts();
      if (target === null || parts === null) return;
      const rect = parts.img.getBoundingClientRect();
      parts.wrap.scrollLeft += rect.left + target.fx * rect.width - target.clientX;
      parts.wrap.scrollTop += rect.top + target.fy * rect.height - target.clientY;
    });
  });
}

function zoomAt(next: number, clientX: number, clientY: number, min = 0.25): void {
  const anchor = anchorAt(clientX, clientY);
  zoom.value = Math.min(8, Math.max(min, next));
  if (anchor !== null) settleAnchor(anchor);
}

/** Botones y teclado: amplían sobre el centro de lo que se ve. */
function zoomCenter(next: number): void {
  const rect = root.value?.querySelector('.stage')?.getBoundingClientRect();
  if (rect === undefined) zoom.value = Math.min(8, Math.max(0.25, next));
  else zoomAt(next, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function onDoubleClick(event: MouseEvent): void {
  if (zoom.value === 1) zoomAt(2.5, event.clientX, event.clientY);
  else zoom.value = 1;
}

function onWheel(event: WheelEvent): void {
  if (kind.value !== 'image' || !event.ctrlKey) return;
  event.preventDefault();
  zoomAt(zoom.value * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX, event.clientY);
}

// Deslizar a izquierda/derecha para cambiar de archivo (solo sin zoom) y pellizcar para ampliar.
let touchStart: { x: number; y: number; t: number } | null = null;
let pinch: { distance: number; zoom: number; fx: number; fy: number } | null = null;

function distanceOf(touches: TouchList): number {
  const a = touches[0] as Touch;
  const b = touches[1] as Touch;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function midpointOf(touches: TouchList): { x: number; y: number } {
  const a = touches[0] as Touch;
  const b = touches[1] as Touch;
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

function onTouchStart(event: TouchEvent): void {
  if (event.touches.length === 2 && kind.value === 'image') {
    const mid = midpointOf(event.touches);
    const anchor = anchorAt(mid.x, mid.y);
    pinch = { distance: Math.max(1, distanceOf(event.touches)), zoom: zoom.value, fx: anchor?.fx ?? 0.5, fy: anchor?.fy ?? 0.5 };
    touchStart = null;
    return;
  }
  const touch = event.touches[0];
  const target = event.target instanceof Element ? event.target : null;
  const interactive = target?.closest('.text-wrap, video, audio, input, .controls, iframe, .image-wrap.zoomed') !== null && target !== null;
  touchStart = event.touches.length === 1 && touch !== undefined && !interactive ? { x: touch.clientX, y: touch.clientY, t: Date.now() } : null;
}

function onTouchMove(event: TouchEvent): void {
  if (pinch === null || event.touches.length !== 2) return;
  event.preventDefault();
  const mid = midpointOf(event.touches);
  zoom.value = Math.min(8, Math.max(1, pinch.zoom * (distanceOf(event.touches) / pinch.distance)));
  settleAnchor({ fx: pinch.fx, fy: pinch.fy, clientX: mid.x, clientY: mid.y });
}
function onTouchEnd(event: TouchEvent): void {
  const touch = event.changedTouches[0];
  if (event.touches.length < 2) pinch = null;
  if (touchStart === null || touch === undefined || zoom.value !== 1) return;
  const dx = touch.clientX - touchStart.x;
  const dy = touch.clientY - touchStart.y;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - touchStart.t < 600) go(dx < 0 ? 1 : -1);
  touchStart = null;
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', measureStage);
  root.value?.focus();
  document.documentElement.style.overflow = 'hidden';
});
onBeforeUnmount(() => {
  cancelAnimationFrame(anchorFrame);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', measureStage);
  document.documentElement.style.overflow = '';
});
</script>

<template>
  <div ref="root" class="viewer" role="dialog" aria-modal="true" :aria-label="current?.name ?? t('viewer.viewer')" tabindex="-1" @contextmenu.stop>
    <header class="bar">
      <button type="button" class="ib" :aria-label="t('viewer.closeViewer')" :title="t('viewer.closeEsc')" @click="emit('close')"><AppIcon name="close" /></button>
      <div class="title">
        <strong>{{ current?.name }}</strong>
        <span v-if="current" class="sub">{{ formatBytes(current.size) }} · {{ t('viewer.position', { n: index + 1, total: items.length }) }}</span>
      </div>
      <template v-if="kind === 'image'">
        <button type="button" class="ib hide-sm" :aria-label="t('viewer.zoomOut')" :title="t('viewer.zoomOutHint')" @click="zoomCenter(zoom / 1.25)"><AppIcon name="zoom-out" /></button>
        <button type="button" class="ib zoom hide-sm" :title="t('viewer.fitSize')" @click="zoom = 1">{{ Math.round(zoom * 100) }}%</button>
        <button type="button" class="ib hide-sm" :aria-label="t('viewer.zoomIn')" :title="t('viewer.zoomInHint')" @click="zoomCenter(zoom * 1.25)"><AppIcon name="zoom-in" /></button>
      </template>
      <button v-if="kind === 'text'" type="button" class="ib" :aria-pressed="wrap" :aria-label="t('viewer.wrapLines')" :title="t('viewer.wrapLines')" @click="wrap = !wrap"><AppIcon name="wrap" /></button>
      <a v-if="kind === 'image' || kind === 'pdf' || kind === 'text'" class="ib hide-sm" :href="kind === 'image' ? imageSrc : inlineUrl(path)" target="_blank" rel="noopener" :aria-label="t('viewer.openInNewTab')" :title="t('viewer.openInNewTab')"><AppIcon name="external" /></a>
      <button v-if="kind === 'video'" type="button" class="ib hide-sm" :aria-label="t('viewer.fullscreen')" :title="t('viewer.fullscreen')" @click="fullscreen"><AppIcon name="expand" /></button>
      <a class="ib" :href="downloadUrl(path)" download @click.prevent="startDownload(downloadUrl(path), current?.name ?? '')" :aria-label="t('viewer.download')" :title="t('viewer.download')"><AppIcon name="download" /></a>
      <button v-if="current" type="button" class="ib" :aria-label="t('viewer.moveToTrash')" :title="t('viewer.moveToTrash')" @click="emit('trash', current)"><AppIcon name="trash" /></button>
    </header>

    <div class="stage" @wheel="onWheel" @touchstart.passive="onTouchStart" @touchmove="onTouchMove" @touchend="onTouchEnd">
      <button v-if="index > 0" type="button" class="nav prev" :aria-label="t('viewer.previous')" @click="go(-1)"><AppIcon name="chevron-left" :size="26" /></button>
      <button v-if="index < items.length - 1" type="button" class="nav next" :aria-label="t('viewer.next')" @click="go(1)"><AppIcon name="chevron" :size="26" /></button>

      <div v-if="loading" class="center"><span class="spinner" aria-hidden="true" /><p>{{ kind === 'office' ? t('viewer.converting') : t('common.loading') }}</p></div>
      <div v-else-if="error" class="center card-ish">
        <AppIcon name="alert" :size="40" :stroke="1.5" />
        <p>{{ error }}</p>
        <a class="btn btn-primary" :href="downloadUrl(path)" download @click.prevent="startDownload(downloadUrl(path), current?.name ?? '')"><AppIcon name="download" />{{ t('viewer.download') }}</a>
      </div>

      <template v-else-if="current">
        <div v-if="kind === 'image'" class="image-wrap" :class="{ zoomed: zoom > 1 }" @dblclick="onDoubleClick">
          <img
            :key="imageSrc"
            :src="imageSrc"
            :alt="current.name"
            :style="imageBox === null ? undefined : { width: `${imageBox.width}px`, height: `${imageBox.height}px` }"
            draggable="false"
            @load="onImageLoad"
            @error="error = t('viewer.imageFailed')"
          >
        </div>

        <div v-else-if="kind === 'video' || kind === 'audio'" class="media" :class="{ audio: isAudioOnly }">
          <div v-if="isAudioOnly" class="cover" :class="{ art: !coverFailed }">
            <img v-if="!coverFailed" :src="thumbUrl(path, 640, current.mtime)" alt="" draggable="false" @error="coverFailed = true">
            <AppIcon v-else name="audio" :size="72" :stroke="1.2" />
          </div>
          <video
            v-if="!isAudioOnly"
            :key="mediaSrc"
            ref="player"
            :src="mediaSrc"
            :controls="!streamed"
            autoplay
            playsinline
            preload="metadata"
            @timeupdate="onTimeUpdate"
            @play="playing = true"
            @pause="playing = false"
            @error="error = streamed ? t('viewer.videoConvertFailed') : t('viewer.browserCantPlay')"
          />
          <audio
            v-else
            :key="mediaSrc"
            ref="player"
            :src="mediaSrc"
            :controls="!streamed"
            autoplay
            preload="metadata"
            @timeupdate="onTimeUpdate"
            @play="playing = true"
            @pause="playing = false"
            @error="error = t('viewer.audioFailed')"
          />
          <div v-if="streamed" class="controls">
            <button type="button" class="ib" :aria-label="playing ? t('viewer.pause') : t('viewer.play')" @click="togglePlay"><AppIcon :name="playing ? 'pause' : 'play'" /></button>
            <span class="time">{{ formatTime(seeking ? seekValue : shownTime) }}</span>
            <input
              class="seek"
              type="range"
              min="0"
              :max="Math.max(1, Math.floor(duration))"
              step="1"
              :value="seeking ? seekValue : Math.floor(shownTime)"
              :aria-label="t('viewer.seek')"
              @pointerdown="seeking = true; seekValue = Math.floor(shownTime)"
              @input="seeking = true; seekValue = Number(($event.target as HTMLInputElement).value)"
              @change="seek"
            >
            <span class="time">{{ formatTime(duration) }}</span>
          </div>
          <p v-if="streamed" class="hint">{{ media?.playback === 'transcode' ? t('viewer.transcoded') : t('viewer.remuxed') }}</p>
        </div>

        <iframe v-else-if="kind === 'pdf'" :key="path" class="doc" :src="inlineUrl(path)" :title="current.name" />
        <iframe v-else-if="kind === 'office' && docUrl" :key="docUrl" class="doc" :src="docUrl" :title="current.name" />

        <div v-else-if="kind === 'text'" class="text-wrap">
          <p v-if="textTruncated" class="notice notice-info">{{ t('viewer.textTruncated') }}</p>
          <pre class="text selectable" :class="{ nowrap: !wrap }">{{ text }}</pre>
        </div>

        <div v-else class="center card-ish">
          <AppIcon :name="fileKind(current.name, 'file').icon" :size="56" :stroke="1.3" />
          <p><strong>{{ fileKind(current.name, 'file').label }}</strong></p>
          <p class="sub">{{ t('viewer.noPreview') }}</p>
          <a class="btn btn-primary" :href="downloadUrl(path)" download @click.prevent="startDownload(downloadUrl(path), current?.name ?? '')"><AppIcon name="download" />{{ t('viewer.downloadSize', { size: formatBytes(current.size) }) }}</a>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  z-index: 800;
  display: flex;
  flex-direction: column;
  background: #0b0d11;
  color: #e8ebf0;
  outline: none;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
}

.bar {
  flex: none;
  min-height: 56px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 10px;
  background: rgb(0 0 0 / 35%);
}

.title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 0 8px;
}

.title strong {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub {
  font-size: 12px;
  color: #9aa3b2;
}

.ib {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: 40px;
  padding: 0 8px;
  border: 0;
  border-radius: 10px;
  background: none;
  color: inherit;
  text-decoration: none;
}

.ib:hover,
.ib[aria-pressed='true'] {
  background: rgb(255 255 255 / 10%);
}

.zoom {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.stage {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.nav {
  position: absolute;
  top: 50%;
  z-index: 2;
  transform: translateY(-50%);
  width: 48px;
  height: 64px;
  border: 0;
  border-radius: 12px;
  background: rgb(0 0 0 / 35%);
  color: #ffffff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.prev {
  left: 10px;
}

.next {
  right: 10px;
}

.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  text-align: center;
  padding: 24px;
}

.spinner {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 3px solid rgb(255 255 255 / 25%);
  border-top-color: #ffffff;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.image-wrap {
  width: 100%;
  height: 100%;
  display: flex;
  overflow: hidden;
}

.image-wrap.zoomed {
  overflow: auto;
}

.image-wrap img {
  margin: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  flex: none;
}

.image-wrap.zoomed img {
  max-width: none;
  max-height: none;
}

.media {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px;
}

.media video {
  max-width: 100%;
  max-height: calc(100% - 70px);
  background: #000000;
  border-radius: 8px;
}

.media.audio audio {
  width: min(560px, 100%);
}

.cover.art {
  background: #000000;
  overflow: hidden;
  box-shadow: 0 18px 50px rgb(0 0 0 / 45%);
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover {
  width: min(320px, 70vw);
  height: min(320px, 70vw);
  border-radius: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #2f5fe0, #7b4dd6);
}

.controls {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(720px, 100%);
}

.seek {
  flex: 1;
  accent-color: #7ba2ff;
}

.time {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: #c4cad4;
}

.hint {
  font-size: 12px;
  color: #9aa3b2;
}

.doc {
  width: 100%;
  height: 100%;
  border: 0;
  background: #ffffff;
}

.text-wrap {
  width: 100%;
  height: 100%;
  overflow: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.text {
  margin: 0;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #e8ebf0;
}

.text.nowrap {
  white-space: pre;
  overflow-wrap: normal;
}

@media (max-width: 640px) {
  .hide-sm {
    display: none;
  }

  .nav {
    width: 40px;
    height: 52px;
    background: rgb(0 0 0 / 25%);
  }
}
</style>
