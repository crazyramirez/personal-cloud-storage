<script setup lang="ts">
import type { BatchResponse, FsEntry, FsListResponse } from '@pcloud/contracts';

// La misma instancia para todas las carpetas: cambiar de carpeta NO vuelve a montar la página
// (si no, la lista se vacía y aparece el esqueleto en cada clic). watch(clientPath) reinicia lo
// que depende de la carpeta.
definePageMeta({ key: 'archivos' });

const route = useRoute();
const storage = useStorage();
const { transfers, enqueue, completedTick, lastCompletedDest, pause, resume, confirmCancel, openPanel } = useTransfers();
const { clipboard } = useFileClipboard();
const session = useSession();
const isOwner = computed(() => session.user.value?.role === 'owner');

const segments = computed<string[]>(() => {
  const raw = route.params.ruta;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return list.filter((segment) => segment !== '');
});
const clientPath = computed(() => `/${segments.value.join('/')}`);
const folderName = computed(() => segments.value.at(-1) ?? t('common.files'));
const crumbs = computed(() => segments.value.map((name, index) => ({ name, to: explorerLink(segments.value.slice(0, index + 1)), path: `/${segments.value.slice(0, index + 1).join('/')}` })));
useHead({ title: () => `${folderName.value} · Personal Cloud` });

const PAGE_SIZE = 500;
const PREFS_KEY = 'pcloud.explorer.prefs';
const entries = ref<FsEntry[]>([]);
const total = ref(0);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
/**
 * Cambiando de carpeta: la lista anterior sigue a la vista (sin responder a clics) hasta que llega
 * la nueva. Si tarda más de SKELETON_DELAY_MS, entonces sí se muestra el esqueleto. Así abrir una
 * carpeta que responde rápido no da un «flash» de esqueleto.
 */
const pending = ref(false);
const SKELETON_DELAY_MS = 250;
let skeletonTimer: ReturnType<typeof setTimeout> | null = null;
/** Últimas listas vistas (por ruta): al volver a una carpeta se muestra al instante y se actualiza. */
const listCache = new Map<string, FsListResponse>();
function remember(path: string, page: FsListResponse): void {
  listCache.delete(path);
  listCache.set(path, page);
  if (listCache.size > 40) listCache.delete(listCache.keys().next().value as string);
}
function settle(): void {
  if (skeletonTimer !== null) clearTimeout(skeletonTimer);
  skeletonTimer = null;
  pending.value = false;
}
const loadingMore = ref(false);
const failure = ref<ApiError | null>(null);
const selection = ref<Set<string>>(new Set());
const anchor = ref<string | null>(null);
const focused = ref<string | null>(null);
/** Archivo abierto en el visor (por nombre: la posición cambia si la carpeta se recarga). */
const viewerName = ref<string | null>(null);
const view = ref<'list' | 'grid'>('list');
/** Tamaño de los elementos en la cuadrícula: pequeño, mediano o grande. */
const gridSize = ref<'sm' | 'md' | 'lg'>('md');
const THUMB_PX = { sm: 160, md: 320, lg: 640 } as const;
const sortKey = ref<'name' | 'date' | 'size' | 'type'>('name');
const sortDesc = ref(false);
const dragging = ref(false);
const dropTarget = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);
const listing = ref<HTMLElement | null>(null);
const brokenThumbs = ref<Set<string>>(new Set());
/** Miniaturas que se sirven con la propia imagen (el servidor no pudo generarlas). */
const directThumbs = ref<Set<string>>(new Set());
/** Filtro rápido por nombre (sin distinguir mayúsculas ni acentos). Se limpia al cambiar de carpeta. */
const filter = ref('');
const filterInput = ref<HTMLInputElement | null>(null);
watch(filter, () => {
  const visible = new Set(sorted.value.map((entry) => entry.name));
  if ([...selection.value].some((name) => !visible.has(name))) {
    selection.value = new Set([...selection.value].filter((name) => visible.has(name)));
  }
});
let requestId = 0;
let dragDepth = 0;
let lastPointer: string = 'mouse';
let typeahead = '';
let typeaheadTimer: ReturnType<typeof setTimeout> | null = null;

// Preferencias del explorador (vista, orden, dirección, panel de detalles): se recuerdan en este
// dispositivo. Se leen antes del primer pintado para que no haya saltos.
const detailsOpen = ref(true);
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<{ view: string; gridSize: string; sortKey: string; sortDesc: boolean; details: boolean }>;
  if (saved.view === 'grid' || saved.view === 'list') view.value = saved.view;
  if (saved.gridSize === 'sm' || saved.gridSize === 'md' || saved.gridSize === 'lg') gridSize.value = saved.gridSize;
  if (saved.sortKey === 'name' || saved.sortKey === 'date' || saved.sortKey === 'size' || saved.sortKey === 'type') sortKey.value = saved.sortKey;
  if (typeof saved.sortDesc === 'boolean') sortDesc.value = saved.sortDesc;
  if (typeof saved.details === 'boolean') detailsOpen.value = saved.details;
} catch {
  // Sin almacenamiento o datos dañados: valores por defecto.
}
watch([view, gridSize, sortKey, sortDesc, detailsOpen], () => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ view: view.value, gridSize: gridSize.value, sortKey: sortKey.value, sortDesc: sortDesc.value, details: detailsOpen.value }));
  } catch {
    // ignorar
  }
});

function asApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError('INTERNAL', () => t('explorer.unexpectedError'), 0, false);
}

function pathOf(name: string, dir = clientPath.value): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

async function load(options: { keepSelection?: boolean; select?: string[] } = {}): Promise<void> {
  const current = ++requestId;
  if (entries.value.length === 0 && !pending.value && !listCache.has(clientPath.value)) loading.value = true;
  failure.value = null;
  try {
    const limit = Math.min(1000, Math.max(PAGE_SIZE, entries.value.length));
    const page = await api<FsListResponse>('/fs/list', { query: { path: clientPath.value, limit } });
    if (current !== requestId) return;
    settle();
    remember(clientPath.value, page);
    entries.value = page.entries;
    total.value = page.total;
    nextCursor.value = page.nextCursor;
    const names = new Set(page.entries.map((entry) => entry.name));
    if (options.select !== undefined) {
      selection.value = new Set(options.select.filter((name) => names.has(name)));
      focused.value = options.select[0] ?? null;
      anchor.value = focused.value;
    } else if (options.keepSelection === true) {
      selection.value = new Set([...selection.value].filter((name) => names.has(name)));
    } else {
      selection.value = new Set();
    }
  } catch (error) {
    if (current !== requestId) return;
    settle();
    listCache.delete(clientPath.value);
    failure.value = asApiError(error);
    entries.value = [];
    total.value = 0;
    nextCursor.value = null;
    if (failure.value.code === 'STORAGE_UNAVAILABLE') void storage.refresh();
  } finally {
    if (current === requestId) {
      loading.value = false;
      openRequestedFile();
    }
  }
}

async function loadMore(): Promise<void> {
  if (nextCursor.value === null || loadingMore.value) return;
  const current = requestId;
  loadingMore.value = true;
  try {
    const page = await api<FsListResponse>('/fs/list', { query: { path: clientPath.value, limit: PAGE_SIZE, cursor: nextCursor.value } });
    if (current !== requestId) return;
    entries.value = [...entries.value, ...page.entries];
    total.value = page.total;
    nextCursor.value = page.nextCursor;
  } catch (error) {
    toast(asApiError(error).message, { tone: 'danger' });
  } finally {
    loadingMore.value = false;
  }
}

watch(clientPath, (path) => {
  filter.value = '';
  settle();
  const cached = listCache.get(path);
  if (cached !== undefined) {
    // Ya visitada: se ve al instante y load() la actualiza por detrás.
    entries.value = cached.entries;
    total.value = cached.total;
    nextCursor.value = cached.nextCursor;
    failure.value = null;
    loading.value = false;
  } else if (entries.value.length > 0 && failure.value === null) {
    pending.value = true;
    skeletonTimer = setTimeout(() => {
      skeletonTimer = null;
      if (!pending.value) return;
      pending.value = false;
      entries.value = [];
      loading.value = true;
    }, SKELETON_DELAY_MS);
  } else {
    entries.value = [];
    loading.value = true;
  }
  selection.value = new Set();
  focused.value = null;
  viewerName.value = null;
  // 8) Las miniaturas fallidas son de ESTA carpeta: no afectan a archivos homónimos de otras.
  brokenThumbs.value = new Set();
  directThumbs.value = new Set();
  void load();
}, { immediate: true });
watch(completedTick, () => {
  if (lastCompletedDest.value === clientPath.value) void load({ keepSelection: true });
});
watch(storage.readable, (now, before) => {
  if (now && !before) void load({ keepSelection: true });
});

// ── Orden y derivados ───────────────────────────────────────────────────────────────────────

const fold = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const sorted = computed(() => {
  const dir = sortDesc.value ? -1 : 1;
  const needle = fold(filter.value.trim());
  const visible = needle === '' ? entries.value : entries.value.filter((entry) => fold(entry.name).includes(needle));
  const names = collator();
  return [...visible].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    let result = 0;
    if (sortKey.value === 'date') result = a.mtime.localeCompare(b.mtime);
    else if (sortKey.value === 'size') result = a.size - b.size;
    else if (sortKey.value === 'type') result = names.compare(extensionOf(a.name), extensionOf(b.name));
    return (result || names.compare(a.name, b.name)) * dir;
  });
});
const files = computed(() => sorted.value.filter((entry) => entry.type === 'file'));
const selected = computed(() => sorted.value.filter((entry) => selection.value.has(entry.name)));
const single = computed(() => (selected.value.length === 1 ? (selected.value[0] as FsEntry) : null));
const selectedBytes = computed(() => selected.value.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : 0), 0));
const countLabel = computed(() => {
  const folders = entries.value.filter((entry) => entry.type === 'dir').length;
  const fileCount = entries.value.length - folders;
  if (total.value > entries.value.length) return t('explorer.countLoaded', { n: entries.value.length, total: total.value });
  return [t('explorer.countFolders', { n: folders }), t('explorer.countFiles', { n: fileCount })].join(' · ');
});
const unavailable = computed(() => failure.value?.code === 'STORAGE_UNAVAILABLE' || (storage.known.value && !storage.readable.value) || storage.unreachable.value);
const missing = computed(() => failure.value?.code === 'NOT_FOUND' || failure.value?.code === 'INVALID_PATH');
const canWrite = computed(() => storage.writable.value && !unavailable.value && !missing.value);
const noWrite = (): string => t('explorer.noWrite');

function iconClass(entry: FsEntry): string {
  const icon = fileKind(entry.name, entry.type).icon;
  return icon === 'folder' ? 'ico-folder' : icon === 'image' || icon === 'video' || icon === 'audio' ? 'ico-media' : 'ico-doc';
}

const thumbKey = (entry: FsEntry): string => `${entry.name}\u0000${entry.mtime}`;

function showThumb(entry: FsEntry): boolean {
  return entry.type === 'file' && entry.size > 0 && hasThumbnail(entry.name) && !brokenThumbs.value.has(thumbKey(entry));
}

function isCut(entry: FsEntry): boolean {
  return clipboard.value?.mode === 'cut' && clipboard.value.paths.includes(pathOf(entry.name));
}

const DIRECT_THUMB_MAX = 8 * 1024 * 1024;

/** Miniatura: la del servidor; si no puede generarla, la propia imagen (si es nativa y pequeña). */
function thumbSrc(entry: FsEntry, size: number): string {
  return directThumbs.value.has(thumbKey(entry)) ? inlineUrl(pathOf(entry.name)) : thumbUrl(pathOf(entry.name), size, entry.mtime);
}

function markBroken(name: string): void {
  const entry = entries.value.find((item) => item.name === name);
  if (entry === undefined) return;
  const key = thumbKey(entry);
  if (!directThumbs.value.has(key) && isNativeImage(name) && entry.size <= DIRECT_THUMB_MAX) {
    directThumbs.value = new Set([...directThumbs.value, key]);
    return;
  }
  brokenThumbs.value = new Set([...brokenThumbs.value, key]);
}

// ── Selección ───────────────────────────────────────────────────────────────────────────────

function selectOnly(name: string): void {
  selection.value = new Set([name]);
  anchor.value = name;
  focused.value = name;
}

function toggle(name: string): void {
  const next = new Set(selection.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  selection.value = next;
  anchor.value = name;
  focused.value = name;
}

function selectRange(name: string): void {
  const names = sorted.value.map((entry) => entry.name);
  const from = names.indexOf(anchor.value ?? name);
  const to = names.indexOf(name);
  if (from === -1 || to === -1) return selectOnly(name);
  const [a, b] = from < to ? [from, to] : [to, from];
  selection.value = new Set(names.slice(a, b + 1));
  focused.value = name;
}

function selectAll(): void {
  selection.value = new Set(sorted.value.map((entry) => entry.name));
}

function clearSelection(): void {
  selection.value = new Set();
}

const touchSelecting = computed(() => lastPointer === 'touch' && selection.value.size > 0);

/** Doble toque (táctil): iOS no emite dblclick de forma fiable, se detecta aquí. */
const DOUBLE_TAP_MS = 320;
let lastTap: { name: string; at: number; before: Set<string> } | null = null;

function onItemClick(event: MouseEvent, entry: FsEntry): void {
  if (longPress.wasLong()) return;
  if (lastPointer === 'touch') {
    // Móvil: un toque selecciona (o marca/desmarca si ya hay selección); doble toque abre.
    const now = performance.now();
    if (lastTap !== null && lastTap.name === entry.name && now - lastTap.at < DOUBLE_TAP_MS) {
      selection.value = lastTap.before; // deshace el primer toque: abrir no cambia la selección
      lastTap = null;
      openEntry(entry);
      return;
    }
    lastTap = { name: entry.name, at: now, before: new Set(selection.value) };
    toggle(entry.name);
    return;
  }
  if (event.shiftKey) selectRange(entry.name);
  else if (event.ctrlKey || event.metaKey) toggle(entry.name);
  else selectOnly(entry.name);
}

function onBackgroundClick(event: MouseEvent): void {
  if (event.target === event.currentTarget) clearSelection();
}

// ── Acciones ────────────────────────────────────────────────────────────────────────────────

function openEntry(entry: FsEntry): void {
  if (entry.type === 'dir') {
    void navigateTo(explorerLink([...segments.value, entry.name]));
    return;
  }
  if (files.value.some((file) => file.name === entry.name)) viewerName.value = entry.name;
}

// Enlace copiado con «Copiar enlace» (…?ver=archivo): al cargar la carpeta se abre ese archivo.
function openRequestedFile(): void {
  const wanted = route.query.ver;
  if (typeof wanted !== 'string' || wanted === '') return;
  if (files.value.some((file) => file.name === wanted)) {
    selectOnly(wanted);
    viewerName.value = wanted;
  } else {
    toast(t('explorer.notInFolder', { name: wanted }), { tone: 'warn' });
  }
  void navigateTo({ path: route.path, query: {} }, { replace: true });
}

const viewerIndex = computed(() => (viewerName.value === null ? -1 : files.value.findIndex((file) => file.name === viewerName.value)));
// Si el archivo abierto desaparece (otro dispositivo lo borró o movió), se cierra el visor.
watch(viewerIndex, (index) => {
  if (viewerName.value !== null && index === -1 && !loading.value) viewerName.value = null;
});

/** 20) Al cerrar el visor, el foco vuelve al archivo que se estaba viendo. */
function closeViewer(): void {
  const name = viewerName.value;
  viewerName.value = null;
  if (name === null) return;
  selectOnly(name);
  void nextTick(() => listing.value?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(name)}"]`)?.focus({ preventScroll: false }));
}

const detailsSheet = ref(false);
const wide = ref(true);
let wideQuery: MediaQueryList | null = null;
const onWideChange = (): void => {
  wide.value = wideQuery?.matches ?? true;
};
onMounted(() => {
  wideQuery = window.matchMedia('(min-width: 1101px)');
  onWideChange();
  wideQuery.addEventListener('change', onWideChange);
});
onBeforeUnmount(() => wideQuery?.removeEventListener('change', onWideChange));
/** El panel de detalles ya se ve en el lateral: «Detalles» no aporta nada en el menú. */
const detailsVisible = computed(() => wide.value && detailsOpen.value);

function showDetails(entry: FsEntry): void {
  selectOnly(entry.name);
  detailsOpen.value = true;
  detailsSheet.value = window.matchMedia('(max-width: 1100px)').matches;
}

function openInNewTab(entry: FsEntry): void {
  const url = entry.type === 'dir' ? explorerLink([...segments.value, entry.name]) : inlineUrl(pathOf(entry.name));
  window.open(url, '_blank', 'noopener');
}

function download(list: FsEntry[]): void {
  if (list.length === 0) return;
  const first = list[0] as FsEntry;
  if (list.length === 1 && first.type === 'file') startDownload(downloadUrl(pathOf(first.name)), first.name);
  else startDownload(zipUrl(clientPath.value, list.map((entry) => entry.name)), zipName(list.length === 1 ? first.name : 'files'));
}

function downloadFolder(): void {
  startDownload(zipUrl(clientPath.value), zipName(segments.value.length === 0 ? 'files' : folderName.value));
}

async function newFolder(): Promise<void> {
  if (!canWrite.value) return;
  let createdName = '';
  const name = await promptDialog({
    title: t('explorer.newFolder'),
    label: t('explorer.nameLabel'),
    value: t('explorer.newFolder'),
    confirm: t('explorer.createFolder'),
    submit: async (value) => {
      const created = await api<{ name: string }>('/fs/folders', { method: 'POST', body: { path: clientPath.value, name: value } });
      createdName = created.name;
    },
  });
  if (name !== null) await load({ select: [createdName] });
}

async function newTextFile(): Promise<void> {
  if (!canWrite.value) return;
  let createdName = '';
  const initial = t('explorer.newTextDocName');
  const name = await promptDialog({
    title: t('explorer.newTextDoc'),
    label: t('explorer.fileNameLabel'),
    value: initial,
    selectLength: baseNameLength(initial, false),
    confirm: t('explorer.create'),
    submit: async (value) => {
      const created = await api<{ name: string }>('/fs/files', { method: 'POST', body: { path: clientPath.value, name: value } });
      createdName = created.name;
    },
  });
  if (name !== null) await load({ select: [createdName] });
}

async function rename(entry: FsEntry): Promise<void> {
  if (!canWrite.value) return;
  let newName = '';
  const result = await promptDialog({
    title: entry.type === 'dir' ? t('explorer.renameFolder') : t('explorer.renameFile'),
    label: t('explorer.newNameLabel'),
    value: entry.name,
    selectLength: baseNameLength(entry.name, entry.type === 'dir'),
    confirm: t('explorer.rename'),
    submit: async (value) => {
      if (value === entry.name) return;
      const renamed = await api<{ name: string }>('/fs/rename', { method: 'POST', body: { path: pathOf(entry.name), name: value } });
      newName = renamed.name;
    },
  });
  if (result !== null && newName !== '') await load({ select: [newName] });
}

function summarize(response: BatchResponse, verb: string): { ok: number; failed: Array<{ from: string; message: string }> } {
  const failed = response.results.filter((item) => !item.ok).map((item) => ({ from: item.from, message: item.ok ? '' : localizeServerError(item.code, item.message) }));
  const ok = response.results.length - failed.length;
  if (failed.length > 0) {
    const first = failed[0] as { from: string; message: string };
    toast(t('explorer.batchFailed', { ok, verb, failed: failed.length, name: first.from.split('/').pop() ?? '', message: first.message }), { tone: 'danger', timeoutMs: 9000 });
  }
  return { ok, failed };
}

async function trash(list: FsEntry[]): Promise<void> {
  if (!canWrite.value || list.length === 0) return;
  const busy = toast(t('explorer.trashing', { n: list.length, name: (list[0] as FsEntry).name }), { busy: true });
  try {
    const response = await api<BatchResponse>('/fs/trash', { method: 'POST', body: { paths: list.map((entry) => pathOf(entry.name)) }, timeoutMs: 0 });
    dismissToast(busy);
    const { ok } = summarize(response, t('explorer.verbMoved'));
    const ids = response.results.flatMap((item) => (item.ok && item.path.startsWith('trash:') ? [item.path.slice(6)] : []));
    if (ok > 0) {
      toast(t('explorer.trashed', { n: ok, name: response.results.find((item) => item.ok)?.name ?? '' }), {
        tone: 'ok',
        action: { label: t('explorer.undo'), run: () => void restore(ids) },
      });
    }
    // En el visor, al eliminar se pasa al archivo siguiente (como en una galería).
    if (viewerName.value !== null && list.some((entry) => entry.name === viewerName.value)) {
      const remaining = files.value.filter((file) => !list.some((entry) => entry.name === file.name));
      const at = Math.min(Math.max(0, viewerIndex.value), remaining.length - 1);
      viewerName.value = remaining[at]?.name ?? null;
    }
    await load();
  } catch (error) {
    dismissToast(busy);
    toast(asApiError(error).message, { tone: 'danger' });
  }
}

/**
 * Eliminar definitivamente sin pasar por la papelera (Mayús+Supr). Solo el propietario y
 * siempre con confirmación: no se puede deshacer.
 */
async function deleteForever(list: FsEntry[]): Promise<void> {
  if (!canWrite.value || list.length === 0) return;
  if (!isOwner.value) {
    toast(t('explorer.ownerOnlyDelete'), { tone: 'info' });
    void trash(list);
    return;
  }
  const ok = await confirmDialog({
    title: t('explorer.deleteForeverTitle', { n: list.length, name: (list[0] as FsEntry).name }),
    message: t('explorer.deleteForeverMessage'),
    confirm: t('explorer.deleteForever'),
    danger: true,
  });
  if (!ok) return;
  const busy = toast(t('explorer.deleting'), { busy: true });
  try {
    const moved = await api<BatchResponse>('/fs/trash', { method: 'POST', body: { paths: list.map((entry) => pathOf(entry.name)) }, timeoutMs: 0 });
    const ids = moved.results.flatMap((item) => (item.ok && item.path.startsWith('trash:') ? [item.path.slice(6)] : []));
    summarize(moved, t('explorer.verbDeleted'));
    if (ids.length > 0) await api('/trash/delete', { method: 'POST', body: { ids }, timeoutMs: 0 });
    dismissToast(busy);
    if (ids.length > 0) toast(t('explorer.deletedForever', { n: ids.length }), { tone: 'ok' });
    await load();
  } catch (error) {
    dismissToast(busy);
    toast(asApiError(error).message, { tone: 'danger' });
  }
}

async function restore(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const response = await api<BatchResponse>('/trash/restore', { method: 'POST', body: { ids } });
    const { ok } = summarize(response, t('explorer.verbRestored'));
    const restored = response.results.flatMap((item) => (item.ok ? [item.path] : []));
    const here = restored.filter((p) => p.slice(0, p.lastIndexOf('/')) === (clientPath.value === '/' ? '' : clientPath.value));
    const elsewhere = restored.filter((p) => !here.includes(p));
    // Lo restaurado queda siempre a la vista: seleccionado aquí, o con acceso a su carpeta.
    if (here.length > 0) {
      filter.value = '';
      await load({ select: here.map((p) => p.slice(p.lastIndexOf('/') + 1)) });
      const first = here[0]?.slice(here[0].lastIndexOf('/') + 1);
      if (first !== undefined) void nextTick(() => listing.value?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(first)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    } else {
      await load({ keepSelection: true });
    }
    if (ok > 0 && elsewhere.length === 0) toast(t('explorer.restored', { n: ok }), { tone: 'ok' });
    if (elsewhere.length > 0) {
      const dir = (elsewhere[0] as string).slice(0, (elsewhere[0] as string).lastIndexOf('/'));
      toast(t('explorer.restoredElsewhere', { n: elsewhere.length, dir: dir === '' ? t('common.files') : (dir.split('/').pop() ?? '') }), {
        tone: 'ok',
        action: { label: t('explorer.openFolder'), run: () => void navigateTo(explorerLink(dir.split('/').filter(Boolean))) },
      });
    }
  } catch (error) {
    toast(asApiError(error).message, { tone: 'danger' });
  }
}

function setClipboard(mode: 'cut' | 'copy', list: FsEntry[]): void {
  if (list.length === 0) return;
  if (mode === 'copy' && list.some((entry) => !entry.portable)) {
    toast(t('explorer.notPortableCopy'), { tone: 'warn' });
    return;
  }
  clipboard.value = { mode, paths: list.map((entry) => pathOf(entry.name)), from: clientPath.value };
  toast(t('explorer.clipboardSet', { n: list.length, name: (list[0] as FsEntry).name, mode }));
}

async function transfer(mode: 'move' | 'copy', paths: string[], destination: string): Promise<boolean> {
  const busy = toast(mode === 'copy' ? t('explorer.copying', { n: paths.length }) : t('explorer.moving'), { busy: true });
  try {
    const response = await api<BatchResponse>(mode === 'copy' ? '/fs/copy' : '/fs/move', { method: 'POST', body: { paths, destination }, timeoutMs: 0 });
    dismissToast(busy);
    const { ok } = summarize(response, mode === 'copy' ? t('explorer.verbCopied') : t('explorer.verbMoved'));
    if (ok > 0) {
      const names = response.results.flatMap((item) => (item.ok ? [item.name] : []));
      toast(t('explorer.transferDone', { n: ok, name: names[0] ?? '', mode, dest: destination === '/' ? t('common.files') : (destination.split('/').pop() ?? '') }), { tone: 'ok' });
    }
    await load({ select: destination === clientPath.value ? response.results.flatMap((item) => (item.ok ? [item.name] : [])) : undefined });
    return ok > 0;
  } catch (error) {
    dismissToast(busy);
    toast(asApiError(error).message, { tone: 'danger' });
    return false;
  }
}

async function paste(destination = clientPath.value): Promise<void> {
  const clip = clipboard.value;
  if (clip === null || !canWrite.value) return;
  if (clip.mode === 'cut' && clip.from === destination) {
    toast(t('explorer.alreadyHereMove'), { tone: 'info' });
    return;
  }
  const done = await transfer(clip.mode === 'cut' ? 'move' : 'copy', clip.paths, destination);
  if (done && clip.mode === 'cut') clipboard.value = null;
}

async function moveOrCopyTo(mode: 'move' | 'copy', list: FsEntry[]): Promise<void> {
  if (list.length === 0) return;
  const destination = await pickFolder({
    title: t(mode === 'move' ? 'explorer.moveTitle' : 'explorer.copyTitle', { n: list.length, name: (list[0] as FsEntry).name }),
    confirm: mode === 'move' ? t('explorer.moveHere') : t('explorer.copyHere'),
    start: clientPath.value,
    forbidden: list.filter((entry) => entry.type === 'dir').map((entry) => pathOf(entry.name)),
  });
  if (destination === null) return;
  if (mode === 'move' && destination === clientPath.value) {
    toast(t('explorer.alreadyHere'), { tone: 'info' });
    return;
  }
  await transfer(mode, list.map((entry) => pathOf(entry.name)), destination);
}

async function duplicate(entry: FsEntry): Promise<void> {
  await transfer('copy', [pathOf(entry.name)], clientPath.value);
}

function setGrid(size: 'sm' | 'md' | 'lg'): void {
  view.value = 'grid';
  gridSize.value = size;
}

/**
 * Enlace que abre la carpeta (o la carpeta con el archivo en el visor) en cualquier dispositivo
 * de tu red con la aplicación: se puede pegar en otro navegador, un mensaje o un acceso directo.
 */
async function copyLink(entry: FsEntry | null): Promise<void> {
  let url = `${window.location.origin}${explorerLink(entry?.type === 'dir' ? [...segments.value, entry.name] : segments.value)}`;
  if (entry !== null && entry.type === 'file') url += `?ver=${encodeURIComponent(entry.name)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(t('explorer.linkCopied'), { tone: 'ok' });
  } catch {
    toast(t('explorer.linkCopyFailed'), { tone: 'danger' });
  }
}

// ── Subidas (archivos y carpetas) ───────────────────────────────────────────────────────────

/** Ejecuta `fn` sobre `items` con como mucho `limit` a la vez. */
async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Sube archivos con su ruta relativa («Viaje/día 1/foto.jpg»), creando antes las carpetas
 * (también las vacías de `emptyDirs`). Las carpetas se crean por niveles y en paralelo, con el
 * progreso a la vista: con miles de carpetas no parece que «no hace nada».
 */
async function uploadTree(items: Array<{ file: File; rel: string }>, emptyDirs: readonly string[] = [], notice?: number): Promise<void> {
  if ((items.length === 0 && emptyDirs.length === 0) || !canWrite.value) {
    if (notice !== undefined) dismissToast(notice);
    return;
  }
  const base = clientPath.value;
  const dirs = new Set<string>();
  const addDir = (rel: string): void => {
    const parts = rel.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  };
  for (const item of items) addDir(item.rel.split('/').slice(0, -1).join('/'));
  for (const dir of emptyDirs) addDir(dir);
  const byDepth = new Map<number, string[]>();
  for (const dir of dirs) {
    const depth = dir.split('/').length;
    byDepth.set(depth, [...(byDepth.get(depth) ?? []), dir]);
  }
  // Aviso de progreso solo si hay carpetas que crear (el de la lectura, si viene, se reutiliza).
  let progress: number | null = notice ?? null;
  if (dirs.size > 0) {
    const message = t('explorer.preparingFolders', { done: 0, total: dirs.size });
    if (progress === null) progress = toast(message, { busy: true });
    else updateToast(progress, { message });
  }
  let created = 0;
  let failedDir: { dir: string; message: string } | null = null;
  for (const depth of [...byDepth.keys()].sort((x, y) => x - y)) {
    await eachLimit(byDepth.get(depth) ?? [], 6, async (dir) => {
      if (failedDir !== null) return;
      const parts = dir.split('/');
      const parent = parts.length === 1 ? base : pathOf(parts.slice(0, -1).join('/'), base);
      try {
        await api('/fs/folders', { method: 'POST', body: { path: parent, name: parts.at(-1) } });
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'CONFLICT')) failedDir = { dir, message: asApiError(error).message };
      }
      created += 1;
      if (progress !== null && (created % 10 === 0 || created === dirs.size)) updateToast(progress, { message: t('explorer.preparingFolders', { done: created, total: dirs.size }) });
    });
    if (failedDir !== null) break;
  }
  if (progress !== null) dismissToast(progress);
  if (failedDir !== null) {
    const { dir, message } = failedDir as { dir: string; message: string };
    toast(t('explorer.folderCreateFailed', { dir, message }), { tone: 'danger' });
    return;
  }
  const groups = new Map<string, File[]>();
  for (const item of items) {
    const parts = item.rel.split('/');
    const dest = parts.length === 1 ? base : pathOf(parts.slice(0, -1).join('/'), base);
    groups.set(dest, [...(groups.get(dest) ?? []), item.file]);
  }
  for (const [dest, group] of groups) enqueue(group, dest);
  if (dirs.size > 0) void load({ keepSelection: true });
  if (items.length > 0) {
    toast(t('explorer.uploading', { n: items.length, name: (items[0] as { file: File }).file.name }), {
      action: { label: t('explorer.viewProgress'), run: openPanel },
    });
  } else {
    toast(t('explorer.foldersCreated', { n: dirs.size }), { tone: 'ok' });
  }
}

function onPicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  const picked = Array.from(input.files ?? []).map((file) => ({ file, rel: file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name }));
  input.value = '';
  void uploadTree(picked);
}

/**
 * Recorre lo soltado (archivos y carpetas, a cualquier profundidad) con varias lecturas a la vez.
 * Devuelve los archivos con su ruta relativa y las carpetas vacías. `onProgress` recibe cuántos
 * archivos lleva: el aviso se actualiza mientras se lee.
 */
async function scanDropped(
  roots: FileSystemEntry[],
  onProgress: (files: number) => void,
): Promise<{ files: Array<{ file: File; rel: string }>; emptyDirs: string[]; failed: number }> {
  const files: Array<{ file: File; rel: string }> = [];
  const emptyDirs: string[] = [];
  let failed = 0;
  const fileOf = (entry: FileSystemFileEntry): Promise<File> => new Promise((resolve, reject) => entry.file(resolve, reject));
  const childrenOf = async (entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> => {
    const reader = entry.createReader();
    const all: FileSystemEntry[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) return all;
      all.push(...batch);
    }
  };
  const queue: Array<{ entry: FileSystemEntry; prefix: string }> = roots.map((entry) => ({ entry, prefix: '' }));
  let active = 0;
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      if (queue.length === 0 && active === 0) return resolve();
      while (active < 8 && queue.length > 0) {
        const { entry, prefix } = queue.shift() as { entry: FileSystemEntry; prefix: string };
        active += 1;
        const work = async (): Promise<void> => {
          if (entry.isFile) {
            files.push({ file: await fileOf(entry as FileSystemFileEntry), rel: `${prefix}${entry.name}` });
            if (files.length % 25 === 0) onProgress(files.length);
          } else if (entry.isDirectory) {
            const children = await childrenOf(entry as FileSystemDirectoryEntry);
            if (children.length === 0) emptyDirs.push(`${prefix}${entry.name}`);
            for (const child of children) queue.push({ entry: child, prefix: `${prefix}${entry.name}/` });
          }
        };
        work()
          .catch(() => {
            failed += 1; // ilegible (permisos, enlace roto): se omite y se avisa al final
          })
          .finally(() => {
            active -= 1;
            pump();
          });
      }
    };
    pump();
  });
  onProgress(files.length);
  return { files, emptyDirs, failed };
}

// Arrastrar y soltar: archivos del ordenador (subir) o elementos de la nube (mover; Ctrl = copiar).
const INTERNAL = 'application/x-pcloud-paths';

function onDragEnter(event: DragEvent): void {
  if (!canWrite.value || !event.dataTransfer?.types.includes('Files')) return;
  dragDepth += 1;
  dragging.value = true;
}

function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
}

async function onDrop(event: DragEvent): Promise<void> {
  dragDepth = 0;
  dragging.value = false;
  if (!canWrite.value || event.dataTransfer === null) return;
  if (event.dataTransfer.types.includes(INTERNAL)) return; // soltado fuera de una carpeta: nada
  // Hay que sacar las entradas YA: tras el primer await el navegador vacía dataTransfer.
  const roots = Array.from(event.dataTransfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.() ?? null);
  const plain = Array.from(event.dataTransfer.files);
  if (roots.length === 0 && plain.length === 0) return;
  if (roots.length === 0 || roots.some((entry) => entry === null)) {
    await uploadTree(plain.map((file) => ({ file, rel: file.name })));
    return;
  }
  // Aviso inmediato: leer carpetas grandes (p. ej. node_modules) lleva su tiempo.
  const notice = toast(t('explorer.readingDropped', { n: 0 }), { busy: true });
  const scanned = await scanDropped(roots as FileSystemEntry[], (n) => updateToast(notice, { message: t('explorer.readingDropped', { n }) }));
  if (scanned.failed > 0) toast(t('explorer.unreadableSkipped', { n: scanned.failed }), { tone: 'warn', timeoutMs: 8000 });
  await uploadTree(scanned.files, scanned.emptyDirs, notice);
}

function onItemDragStart(event: DragEvent, entry: FsEntry): void {
  longPress.cancel();
  if (!canWrite.value || event.dataTransfer === null) return;
  if (!selection.value.has(entry.name)) selectOnly(entry.name);
  const paths = selected.value.map((item) => pathOf(item.name));
  event.dataTransfer.setData(INTERNAL, JSON.stringify(paths));
  event.dataTransfer.effectAllowed = 'copyMove';
}

function canDropInto(event: DragEvent, targetPath: string): boolean {
  if (!canWrite.value || event.dataTransfer === null || !event.dataTransfer.types.includes(INTERNAL)) return false;
  const moving = selected.value.map((item) => pathOf(item.name));
  return !moving.some((path) => targetPath === path || targetPath.startsWith(`${path}/`));
}

function onFolderDragOver(event: DragEvent, targetPath: string): void {
  if (!canDropInto(event, targetPath)) return;
  event.preventDefault();
  event.stopPropagation();
  (event.dataTransfer as DataTransfer).dropEffect = event.ctrlKey || event.altKey ? 'copy' : 'move';
  dropTarget.value = targetPath;
}

async function onFolderDrop(event: DragEvent, targetPath: string): Promise<void> {
  dropTarget.value = null;
  if (!canDropInto(event, targetPath)) return;
  event.preventDefault();
  event.stopPropagation();
  const paths = JSON.parse((event.dataTransfer as DataTransfer).getData(INTERNAL) || '[]') as string[];
  if (paths.length > 0) await transfer(event.ctrlKey || event.altKey ? 'copy' : 'move', paths, targetPath);
}

// ── Menús contextuales ──────────────────────────────────────────────────────────────────────

/** `alone`: menú solo de ese elemento, aunque haya otros seleccionados (pulsación larga en uno sin seleccionar). */
function itemMenu(entry: FsEntry, alone = false): MenuItem[] {
  const w = !canWrite.value;
  const list = alone ? [entry] : selected.value;
  const clip = clipboard.value;
  if (list.length > 1) {
    return [
      { label: t('explorer.downloadItemsZip', { n: list.length }), icon: 'archive', run: () => download(list) },
      { label: t('explorer.cut'), icon: 'cut', shortcut: 'Ctrl+X', disabled: w, hint: noWrite(), separator: true, run: () => setClipboard('cut', list) },
      { label: t('explorer.copy'), icon: 'copy', shortcut: 'Ctrl+C', run: () => setClipboard('copy', list) },
      { label: t('explorer.moveTo'), icon: 'move', disabled: w, hint: noWrite(), run: () => void moveOrCopyTo('move', list) },
      { label: t('explorer.copyTo'), icon: 'copy', disabled: w, hint: noWrite(), run: () => void moveOrCopyTo('copy', list) },
      { label: t('explorer.selectAll'), icon: 'check-all', shortcut: 'Ctrl+A', separator: true, run: selectAll },
      { label: t('explorer.trashItems', { n: list.length }), icon: 'trash', shortcut: t('explorer.keyDelete'), danger: true, disabled: w, hint: noWrite(), separator: true, run: () => void trash(list) },
      ...(isOwner.value ? [{ label: t('explorer.deleteForever'), icon: 'trash-x' as const, shortcut: t('explorer.keyShiftDelete'), danger: true, disabled: w, hint: noWrite(), run: () => void deleteForever(list) }] : []),
    ];
  }
  const isDir = entry.type === 'dir';
  const kind = viewerKind(entry.name);
  return [
    { label: isDir ? t('explorer.open') : VIEWER_LABEL[kind], icon: isDir ? 'folder' : 'eye', shortcut: t('explorer.keyEnter'), run: () => openEntry(entry) },
    { label: t('explorer.openInNewTab'), icon: 'external', run: () => openInNewTab(entry) },
    { label: isDir ? t('explorer.downloadAsZip') : t('explorer.download'), icon: isDir ? 'archive' : 'download', run: () => download([entry]) },
    { label: t('explorer.cut'), icon: 'cut', shortcut: 'Ctrl+X', disabled: w, hint: noWrite(), separator: true, run: () => setClipboard('cut', [entry]) },
    { label: t('explorer.copy'), icon: 'copy', shortcut: 'Ctrl+C', disabled: !entry.portable, hint: t('explorer.renameFirst'), run: () => setClipboard('copy', [entry]) },
    ...(isDir && clip !== null
      ? [{ label: t('explorer.pasteInto', { n: clip.paths.length }), icon: 'paste' as const, disabled: w, hint: noWrite(), run: () => void paste(pathOf(entry.name)) }]
      : []),
    { label: t('explorer.moveTo'), icon: 'move', disabled: w, hint: noWrite(), run: () => void moveOrCopyTo('move', [entry]) },
    { label: t('explorer.copyTo'), icon: 'copy', disabled: w || !entry.portable, hint: w ? noWrite() : t('explorer.notPortable'), run: () => void moveOrCopyTo('copy', [entry]) },
    { label: t('explorer.duplicate'), icon: 'copy', disabled: w || !entry.portable, hint: w ? noWrite() : t('explorer.notPortable'), run: () => void duplicate(entry) },
    { label: t('explorer.rename'), icon: 'edit', shortcut: 'F2', disabled: w, hint: noWrite(), separator: true, run: () => void rename(entry) },
    { label: t('explorer.copyLink'), icon: 'link', run: () => void copyLink(entry) },
    // Enlace para invitados sin cuenta (ADR-0018): solo el propietario.
    ...(isOwner.value ? [{ label: t('shares.menu'), icon: 'globe' as const, run: () => void shareDialog({ path: pathOf(entry.name), name: entry.name, kind: entry.type }) }] : []),
    // «Detalles» solo cuando el panel lateral no se ve (pantalla estrecha o panel cerrado).
    ...(!detailsVisible.value ? [{ label: t('explorer.details'), icon: 'info' as const, run: () => showDetails(entry) }] : []),
    { label: t('explorer.moveToTrash'), icon: 'trash', shortcut: t('explorer.keyDelete'), danger: true, disabled: w, hint: noWrite(), separator: true, run: () => void trash([entry]) },
    ...(isOwner.value ? [{ label: t('explorer.deleteForever'), icon: 'trash-x' as const, shortcut: t('explorer.keyShiftDelete'), danger: true, disabled: w, hint: noWrite(), run: () => void deleteForever([entry]) }] : []),
  ];
}

function backgroundMenu(): MenuItem[] {
  const w = !canWrite.value;
  const clip = clipboard.value;
  return [
    { label: t('explorer.newFolder'), icon: 'folder-plus', disabled: w, hint: noWrite(), run: () => void newFolder() },
    { label: t('explorer.newTextDoc'), icon: 'file-plus', disabled: w, hint: noWrite(), run: () => void newTextFile() },
    { label: t('explorer.uploadFilesMenu'), icon: 'upload', disabled: w, hint: noWrite(), separator: true, run: () => fileInput.value?.click() },
    { label: t('explorer.uploadFolderMenu'), icon: 'folder-upload', disabled: w, hint: noWrite(), run: () => folderInput.value?.click() },
    ...(clip !== null
      ? [{ label: t('explorer.pasteItems', { n: clip.paths.length }), icon: 'paste' as const, shortcut: 'Ctrl+V', disabled: w, hint: noWrite(), separator: true, run: () => void paste() }]
      : []),
    { label: t('explorer.selectAll'), icon: 'check-all', shortcut: 'Ctrl+A', separator: true, disabled: entries.value.length === 0, run: selectAll },
    { label: t('explorer.refresh'), icon: 'refresh', run: () => void load({ keepSelection: true }) },
    { label: t('explorer.sortByName'), checked: sortKey.value === 'name', separator: true, run: () => setSort('name') },
    { label: t('explorer.sortByDate'), checked: sortKey.value === 'date', run: () => setSort('date') },
    { label: t('explorer.sortBySize'), checked: sortKey.value === 'size', run: () => setSort('size') },
    { label: t('explorer.sortByType'), checked: sortKey.value === 'type', run: () => setSort('type') },
    { label: t('explorer.viewList'), icon: 'list', checked: view.value === 'list', separator: true, run: () => (view.value = 'list') },
    { label: t('explorer.iconsSmall'), icon: 'grid-sm', checked: view.value === 'grid' && gridSize.value === 'sm', run: () => setGrid('sm') },
    { label: t('explorer.iconsMedium'), icon: 'grid', checked: view.value === 'grid' && gridSize.value === 'md', run: () => setGrid('md') },
    { label: t('explorer.iconsLarge'), icon: 'grid-lg', checked: view.value === 'grid' && gridSize.value === 'lg', run: () => setGrid('lg') },
    { label: t('explorer.downloadThisFolder'), icon: 'archive', separator: true, disabled: entries.value.length === 0, run: downloadFolder },
    { label: t('explorer.copyFolderLink'), icon: 'link', run: () => void copyLink(null) },
  ];
}

function crumbMenu(path: string, link: string): MenuItem[] {
  const clip = clipboard.value;
  return [
    { label: t('explorer.open'), icon: 'folder', run: () => void navigateTo(link) },
    { label: t('explorer.openInNewTab'), icon: 'external', run: () => window.open(link, '_blank', 'noopener') },
    ...(clip !== null ? [{ label: t('explorer.pasteHere', { n: clip.paths.length }), icon: 'paste' as const, disabled: !canWrite.value, hint: noWrite(), run: () => void paste(path) }] : []),
    { label: t('explorer.downloadAsZip'), icon: 'archive', run: () => startDownload(zipUrl(path), zipName(path.split('/').filter(Boolean).at(-1) ?? 'files')) },
  ];
}

function onItemContext(event: MouseEvent | KeyboardEvent, entry: FsEntry): void {
  if (!selection.value.has(entry.name)) selectOnly(entry.name);
  focused.value = entry.name;
  openMenuFor(event, itemMenu(entry), selection.value.size > 1 ? t('explorer.itemsSelected', { n: selection.value.size }) : entry.name);
}

function onBackgroundContext(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  // Campos de texto: menú nativo (copiar/pegar). Elementos, ruta y menús propios: lo gestionan ellos.
  if (target.closest('input, textarea, [contenteditable], [data-entry], .crumbs, .ctx, .viewer, .details') !== null) return;
  clearSelection();
  openMenuFor(event, backgroundMenu(), folderName.value);
}

const longPress = useLongPress((point) => {
  const target = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('[data-entry]');
  const name = target?.dataset['entry'];
  const entry = name === undefined ? undefined : entries.value.find((item) => item.name === name);
  if (entry === undefined) {
    openMenuFor(point, backgroundMenu(), folderName.value);
    return;
  }
  // Mantener pulsado solo abre el menú: no selecciona el elemento (si ya había una selección
  // que lo incluye, el menú es el de toda la selección).
  const inSelection = selection.value.has(entry.name) && selection.value.size > 1;
  openMenuFor(point, inSelection ? itemMenu(entry) : itemMenu(entry, true), inSelection ? t('explorer.itemsSelected', { n: selection.value.size }) : entry.name);
});

function setSort(key: typeof sortKey.value): void {
  if (sortKey.value === key) sortDesc.value = !sortDesc.value;
  else {
    sortKey.value = key;
    sortDesc.value = key === 'date' || key === 'size';
  }
}

// ── Teclado ─────────────────────────────────────────────────────────────────────────────────

function columns(): number {
  if (view.value === 'list') return 1;
  const grid = listing.value?.querySelector('.grid');
  const tile = grid?.querySelector('li');
  if (grid === null || grid === undefined || tile === null || tile === undefined) return 1;
  return Math.max(1, Math.round(grid.clientWidth / (tile as HTMLElement).offsetWidth));
}

function moveFocus(step: number, extend: boolean): void {
  const names = sorted.value.map((entry) => entry.name);
  if (names.length === 0) return;
  const at = focused.value === null ? -1 : names.indexOf(focused.value);
  const next = Math.min(names.length - 1, Math.max(0, at === -1 ? 0 : at + step));
  const name = names[next] as string;
  if (extend) selectRange(name);
  else selectOnly(name);
  void nextTick(() => listing.value?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(name)}"]`)?.focus({ preventScroll: false }));
}

function onKeydown(event: KeyboardEvent): void {
  if (viewerName.value !== null) return;
  // 15) Nada de atajos con un diálogo o un menú abiertos, aunque el foco haya quedado en <body>.
  if (document.querySelector('dialog[open], .ctx') !== null) return;
  const target = event.target instanceof Element ? event.target : document.body;
  if (target.closest('input, textarea, select, dialog, [role="menu"]') !== null) return;
  // 2) Intro y Espacio pertenecen al botón o enlace con el foco (Descargar, Deshacer, ruta…).
  if ((event.key === 'Enter' || event.key === ' ') && target.closest('button, a, [role="button"]') !== null && target.closest('[data-entry]') === null) return;
  const ctrl = event.ctrlKey || event.metaKey;
  const list = selected.value;
  const key = event.key;
  if (key === '/' && !ctrl) {
    filterInput.value?.focus();
  } else if (ctrl && key.toLowerCase() === 'a') selectAll();
  else if (ctrl && (key.toLowerCase() === 'c' || key.toLowerCase() === 'x') && (window.getSelection()?.toString() ?? '') !== '') return; // copiar texto seleccionado
  else if (ctrl && key.toLowerCase() === 'c') setClipboard('copy', list);
  else if (ctrl && key.toLowerCase() === 'x' && canWrite.value) setClipboard('cut', list);
  else if (ctrl && key.toLowerCase() === 'v') void paste();
  else if (key === 'Delete' && event.shiftKey && list.length > 0) void deleteForever(list);
  else if (key === 'Delete' && list.length > 0) void trash(list);
  else if (key === 'F2' && single.value !== null) void rename(single.value);
  else if (key === 'Enter' && single.value !== null) openEntry(single.value);
  else if (key === 'Escape') clearSelection();
  else if ((key === 'Backspace' || (event.altKey && key === 'ArrowUp')) && segments.value.length > 0) void navigateTo(explorerLink(segments.value.slice(0, -1)));
  else if (key === 'ArrowDown') moveFocus(columns(), event.shiftKey);
  else if (key === 'ArrowUp') moveFocus(-columns(), event.shiftKey);
  else if (key === 'ArrowRight' && view.value === 'grid') moveFocus(1, event.shiftKey);
  else if (key === 'ArrowLeft' && view.value === 'grid') moveFocus(-1, event.shiftKey);
  else if (key === 'Home') moveFocus(-1e6, event.shiftKey);
  else if (key === 'End') moveFocus(1e6, event.shiftKey);
  else if ((key === 'ContextMenu' || (event.shiftKey && key === 'F10')) && single.value !== null) onItemContext(event, single.value);
  else if (key.length === 1 && !ctrl && !event.altKey) {
    // Escribir para saltar a un nombre, como en el Explorador de Windows.
    typeahead += key.toLowerCase();
    if (typeaheadTimer !== null) clearTimeout(typeaheadTimer);
    typeaheadTimer = setTimeout(() => (typeahead = ''), 800);
    const match = sorted.value.find((entry) => entry.name.toLowerCase().startsWith(typeahead));
    if (match !== undefined) {
      selectOnly(match.name);
      void nextTick(() => listing.value?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(match.name)}"]`)?.focus());
    }
    return;
  } else return;
  event.preventDefault();
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

function onPointerDown(event: PointerEvent): void {
  lastPointer = event.pointerType;
}

// ── Subidas en curso dentro de la carpeta ───────────────────────────────────────────────────

/**
 * Subidas con destino en esta carpeta. Las terminadas siguen visibles hasta que el listado ya
 * muestra el archivo real (sin huecos ni saltos al pasar de «subiendo» a «guardado»).
 */
const ghosts = computed(() => {
  const listed = new Set(entries.value.map((entry) => entry.name));
  return transfers.value.filter((item) => {
    if (item.dest !== clientPath.value || item.state === 'cancelled') return false;
    if (item.state === 'done') return !item.settled && !listed.has(item.finalName ?? item.name);
    return true;
  });
});

// En cuanto el archivo real aparece en la carpeta, su subida queda asentada para siempre: si
// luego se elimina o se mueve, no vuelve a mostrarse «Guardado en el disco».
watch(entries, (list) => {
  const listed = new Set(list.map((entry) => entry.name));
  for (const item of transfers.value) {
    if (item.state === 'done' && !item.settled && item.dest === clientPath.value && listed.has(item.finalName ?? item.name)) {
      item.settled = true;
    }
  }
});

const previews = new Map<number, string>();
function localPreview(item: Transfer): string | null {
  if (!item.file.type.startsWith('image/') || item.size > 15 * 1024 * 1024) return null;
  if (!previews.has(item.id) && previews.size >= 24) return null;
  let url = previews.get(item.id);
  if (url === undefined) {
    url = URL.createObjectURL(item.file);
    previews.set(item.id, url);
  }
  return url;
}
onBeforeUnmount(() => {
  for (const url of previews.values()) URL.revokeObjectURL(url);
});

function ghostPercent(item: Transfer): number {
  return item.size === 0 ? 1 : item.uploaded / item.size;
}

function ghostStatus(item: Transfer): { text: string; tone: 'accent' | 'warn' | 'danger' | 'muted' | 'ok' } {
  const pct = t('explorer.percent', { n: Math.floor(ghostPercent(item) * 100) });
  switch (item.state) {
    case 'uploading':
      return { text: [t('explorer.ghostUploading', { pct }), formatSpeed(item.speed), item.speed > 0 ? formatRemaining((item.size - item.uploaded) / item.speed) : ''].filter(Boolean).join(' · '), tone: 'accent' };
    case 'queued':
      return { text: item.uploaded > 0 ? t('explorer.ghostQueuedPct', { pct }) : t('explorer.ghostQueued'), tone: 'muted' };
    case 'waiting':
      return { text: t('explorer.ghostWaiting', { pct, reason: item.message || t('explorer.ghostAutoResume') }), tone: 'warn' };
    case 'paused':
      return { text: t('explorer.ghostPaused', { pct }), tone: 'muted' };
    case 'error':
      return { text: t('explorer.ghostError', { message: item.message }), tone: 'danger' };
    default:
      return { text: t('explorer.ghostSaved'), tone: 'ok' };
  }
}

function ghostMenu(item: Transfer): MenuItem[] {
  const active = item.state === 'uploading' || item.state === 'queued' || item.state === 'waiting';
  return [
    { label: t('explorer.pause'), icon: 'pause', disabled: !active, run: () => pause(item.id) },
    { label: item.state === 'error' ? t('common.retry') : t('explorer.resume'), icon: 'play', disabled: item.state !== 'paused' && item.state !== 'error' && item.state !== 'waiting', run: () => resume(item.id) },
    { label: t('explorer.viewAllTransfers'), icon: 'upload', separator: true, run: openPanel },
    { label: t('explorer.cancelUpload'), icon: 'close', danger: true, separator: true, disabled: item.state === 'done', run: () => void confirmCancel(item) },
  ];
}

</script>

<template>
  <div
    class="explorer"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
    @pointerdown.capture="onPointerDown"
    @contextmenu="onBackgroundContext"
  >
    <nav :aria-label="t('explorer.breadcrumb')" class="crumbs muted">
      <ol>
        <li>
          <NuxtLink
            to="/archivos"
            class="crumb"
            :class="{ here: segments.length === 0, drop: dropTarget === '/' }"
            :aria-current="segments.length === 0 ? 'page' : undefined"
            @contextmenu.prevent="openMenuFor($event, crumbMenu('/', '/archivos'), t('common.files'))"
            @dragover="onFolderDragOver($event, '/')"
            @dragleave="dropTarget = null"
            @drop="onFolderDrop($event, '/')"
          ><AppIcon name="home" :size="15" />{{ t('common.files') }}</NuxtLink>
        </li>
        <template v-for="(crumb, index) in crumbs" :key="crumb.to">
          <li aria-hidden="true" class="sep"><AppIcon name="chevron" :size="14" :stroke="2" /></li>
          <li>
            <NuxtLink
              :to="crumb.to"
              class="crumb"
              :class="{ here: index === crumbs.length - 1, drop: dropTarget === crumb.path }"
              :aria-current="index === crumbs.length - 1 ? 'page' : undefined"
              @contextmenu.prevent="openMenuFor($event, crumbMenu(crumb.path, crumb.to), crumb.name)"
              @dragover="onFolderDragOver($event, crumb.path)"
              @dragleave="dropTarget = null"
              @drop="onFolderDrop($event, crumb.path)"
            >{{ crumb.name }}</NuxtLink>
          </li>
        </template>
      </ol>
    </nav>

    <div class="toolbar">
      <div class="heading">
        <h1>{{ folderName }}</h1>
        <span v-if="!loading && !failure && !unavailable" class="muted count">{{ countLabel }}</span>
      </div>
      <label class="search" :class="{ active: filter !== '' }">
        <AppIcon name="search" :size="17" class="muted" />
        <span class="sr-only">{{ t('explorer.filterLabel') }}</span>
        <input
          ref="filterInput"
          v-model="filter"
          type="search"
          :placeholder="t('explorer.filterPlaceholder')"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          enterkeyhint="search"
          @keydown.escape.stop="filter = ''; ($event.target as HTMLInputElement).blur()"
        >
        <button v-if="filter !== ''" type="button" class="clear" :aria-label="t('explorer.clearFilter')" @click="filter = ''"><AppIcon name="close" :size="14" /></button>
      </label>
      <button type="button" class="btn hide-sm" :disabled="!canWrite" :title="canWrite ? t('explorer.newFolder') : noWrite()" @click="newFolder">
        <AppIcon name="folder-plus" />{{ t('explorer.newFolder') }}
      </button>
      <button v-if="clipboard" type="button" class="btn" :disabled="!canWrite" :title="canWrite ? t('explorer.pasteShortcut') : noWrite()" @click="paste()">
        <AppIcon name="paste" />{{ t('explorer.pasteCount', { n: clipboard.paths.length }) }}
      </button>
      <div class="sorter hide-sm">
        <label for="orden" class="sr-only">{{ t('explorer.sortBy') }}</label>
        <select id="orden" v-model="sortKey" class="input select">
          <option value="name">{{ t('explorer.colName') }}</option>
          <option value="date">{{ t('explorer.colDate') }}</option>
          <option value="size">{{ t('explorer.colSize') }}</option>
          <option value="type">{{ t('explorer.colType') }}</option>
        </select>
        <button type="button" class="btn btn-icon" :aria-label="sortDesc ? t('explorer.sortDescending') : t('explorer.sortAscending')" :title="sortDesc ? t('explorer.descending') : t('explorer.ascending')" @click="sortDesc = !sortDesc">
          <AppIcon :name="sortDesc ? 'chevron-down' : 'chevron-up'" />
        </button>
      </div>
      <div class="views">
        <button type="button" :aria-pressed="view === 'list'" :aria-label="t('explorer.viewList')" :title="t('explorer.viewList')" :class="{ on: view === 'list' }" @click="view = 'list'"><AppIcon name="list" /></button>
        <button type="button" :aria-pressed="view === 'grid' && gridSize === 'sm'" :aria-label="t('explorer.iconsSmall')" :title="t('explorer.iconsSmall')" :class="{ on: view === 'grid' && gridSize === 'sm' }" @click="setGrid('sm')"><AppIcon name="grid-sm" /></button>
        <button type="button" :aria-pressed="view === 'grid' && gridSize === 'md'" :aria-label="t('explorer.iconsMedium')" :title="t('explorer.iconsMedium')" :class="{ on: view === 'grid' && gridSize === 'md' }" @click="setGrid('md')"><AppIcon name="grid" /></button>
        <button type="button" :aria-pressed="view === 'grid' && gridSize === 'lg'" :aria-label="t('explorer.iconsLarge')" :title="t('explorer.iconsLarge')" :class="{ on: view === 'grid' && gridSize === 'lg' }" @click="setGrid('lg')"><AppIcon name="grid-lg" /></button>
      </div>
      <button v-if="!detailsOpen" type="button" class="btn btn-icon details-toggle" :aria-label="t('explorer.showDetails')" :title="t('explorer.showDetailsPanel')" @click="detailsOpen = true"><AppIcon name="info" /></button>
      <button type="button" class="btn btn-icon" :aria-label="t('explorer.moreActions')" :title="t('explorer.moreActions')" @click="openMenuFor($event, backgroundMenu(), folderName)"><AppIcon name="more" /></button>
      <button type="button" class="btn btn-primary upload-btn" :class="{ 'fab-hidden': selection.size > 0 }" :disabled="!canWrite" :title="canWrite ? t('explorer.uploadFiles') : noWrite()" :aria-label="t('explorer.uploadFiles')" @click="fileInput?.click()">
        <AppIcon name="upload" :stroke="1.9" /><span class="hide-xs">{{ t('explorer.upload') }}</span>
      </button>
      <input ref="fileInput" type="file" multiple class="sr-only" tabindex="-1" aria-hidden="true" @change="onPicked">
      <input ref="folderInput" type="file" webkitdirectory multiple class="sr-only" tabindex="-1" aria-hidden="true" @change="onPicked">
    </div>

    <div v-if="selection.size > 0 && !unavailable" class="selbar" role="toolbar" :aria-label="t('explorer.selectionActions')">
      <button type="button" class="btn btn-icon" :aria-label="t('explorer.clearSelection')" @click="clearSelection"><AppIcon name="close" /></button>
      <strong>{{ t('explorer.selectedCount', { n: selection.size }) }}</strong>
      <span v-if="selectedBytes > 0" class="muted hide-xs">{{ formatBytes(selectedBytes) }}</span>
      <span class="grow" />
      <button type="button" class="btn btn-icon" :aria-label="t('explorer.download')" :title="t('explorer.download')" @click="download(selected)"><AppIcon name="download" /></button>
      <button type="button" class="btn btn-icon" :aria-label="t('explorer.moveTo')" :title="t('explorer.moveTo')" :disabled="!canWrite" @click="moveOrCopyTo('move', selected)"><AppIcon name="move" /></button>
      <button v-if="single" type="button" class="btn btn-icon" :aria-label="t('explorer.rename')" :title="t('explorer.renameF2')" :disabled="!canWrite" @click="rename(single)"><AppIcon name="edit" /></button>
      <button type="button" class="btn btn-icon danger" :aria-label="t('explorer.moveToTrash')" :title="t('explorer.moveToTrashKey')" :disabled="!canWrite" @click="trash(selected)"><AppIcon name="trash" /></button>
      <button type="button" class="btn btn-icon" :aria-label="t('explorer.moreActions')" @click="openMenuFor($event, itemMenu(selected[0] as FsEntry), t('explorer.selectedTitle', { n: selection.size }))"><AppIcon name="more" /></button>
    </div>

    <p v-if="storage.state.value === 'READ_ONLY'" class="notice notice-warn">
      <AppIcon name="alert" /><span>{{ t('explorer.readOnly') }}</span>
    </p>

    <DiskUnavailable v-if="unavailable && storage.state.value !== 'READ_ONLY'" />

    <section v-else-if="missing" class="card empty">
      <AppIcon name="folder" :size="40" :stroke="1.5" class="muted" />
      <h2>{{ t('explorer.missingTitle') }}</h2>
      <p class="muted">{{ t('explorer.missingHint') }}</p>
      <NuxtLink to="/archivos" class="btn">{{ t('explorer.backToFiles') }}</NuxtLink>
    </section>

    <section v-else-if="failure" class="card empty">
      <AppIcon name="alert" :size="40" :stroke="1.5" class="muted" />
      <h2>{{ t('explorer.loadFailed') }}</h2>
      <p class="muted">{{ failure.message }}</p>
      <button type="button" class="btn" @click="load()"><AppIcon name="refresh" />{{ t('common.retry') }}</button>
    </section>

    <div v-else class="columns">
      <section
        ref="listing"
        :aria-label="t('explorer.listing')"
        class="listing"
        :class="{ dragging, stale: pending }"
        :aria-busy="loading || pending"
        @click="onBackgroundClick"
        @touchstart.passive="longPress.onTouchstart"
        @touchmove.passive="longPress.onTouchmove"
        @touchend="longPress.onTouchend"
        @touchcancel="longPress.onTouchcancel"
      >
        <ul v-if="loading" class="skeleton" aria-hidden="true">
          <li v-for="n in 6" :key="n" />
        </ul>

        <div v-else-if="entries.length === 0 && ghosts.length === 0" class="card empty">
          <AppIcon name="folder" :size="44" :stroke="1.4" class="ico-folder" />
          <h2>{{ t('explorer.emptyTitle') }}</h2>
          <p class="muted">{{ t('explorer.emptyHint') }}</p>
          <div v-if="canWrite" class="empty-actions">
            <button type="button" class="btn" @click="newFolder"><AppIcon name="folder-plus" />{{ t('explorer.newFolder') }}</button>
            <button type="button" class="btn" @click="folderInput?.click()"><AppIcon name="folder-upload" />{{ t('explorer.uploadFolder') }}</button>
            <button v-if="clipboard" type="button" class="btn" @click="paste()"><AppIcon name="paste" />{{ t('explorer.paste') }}</button>
          </div>
        </div>

        <div v-else-if="sorted.length === 0 && filter !== '' && ghosts.length === 0" class="card empty">
          <AppIcon name="search" :size="40" :stroke="1.4" class="muted" />
          <h2>{{ t('explorer.noMatch', { filter }) }}</h2>
          <p class="muted">{{ t('explorer.noMatchHint') }}</p>
          <button type="button" class="btn" @click="filter = ''">{{ t('explorer.clearFilter') }}</button>
        </div>

        <template v-else>
          <div v-if="view === 'list'" class="table" role="grid" aria-multiselectable="true" :aria-rowcount="sorted.length">
            <div class="row head muted" role="row">
              <button type="button" class="hcell" role="columnheader" :aria-sort="sortKey === 'name' ? (sortDesc ? 'descending' : 'ascending') : 'none'" @click="setSort('name')">{{ t('explorer.colName') }}<AppIcon v-if="sortKey === 'name'" :name="sortDesc ? 'chevron-down' : 'chevron-up'" :size="13" /></button>
              <button type="button" class="hcell" role="columnheader" :aria-sort="sortKey === 'size' ? (sortDesc ? 'descending' : 'ascending') : 'none'" @click="setSort('size')">{{ t('explorer.colSize') }}<AppIcon v-if="sortKey === 'size'" :name="sortDesc ? 'chevron-down' : 'chevron-up'" :size="13" /></button>
              <button type="button" class="hcell col-date" role="columnheader" :aria-sort="sortKey === 'date' ? (sortDesc ? 'descending' : 'ascending') : 'none'" @click="setSort('date')">{{ t('explorer.colModified') }}<AppIcon v-if="sortKey === 'date'" :name="sortDesc ? 'chevron-down' : 'chevron-up'" :size="13" /></button>
            </div>
            <ul>
              <li
                v-for="item in ghosts"
                :key="`up-${item.id}`"
                class="row ghost"
                :class="`g-${item.state}`"
                style="order: 1"
                role="row"
                :aria-label="`${item.name}: ${ghostStatus(item).text}`"
                @contextmenu.prevent.stop="openMenuFor($event, ghostMenu(item), item.name)"
                @click.stop="openMenuFor($event, ghostMenu(item), item.name)"
              >
                <span class="name" role="gridcell">
                  <span class="ghost-ico">
                    <AppIcon :name="fileKind(item.name, 'file').icon" :size="18" class="ico-doc" />
                    <ProgressRing class="ghost-ring" :value="item.state === 'queued' && item.uploaded === 0 ? null : ghostPercent(item)" :size="34" :stroke="3" :tone="ghostStatus(item).tone" />
                  </span>
                  <span class="label">
                    <span class="text">{{ item.finalName ?? item.name }}</span>
                    <span class="gstatus" :class="`t-${ghostStatus(item).tone}`">{{ ghostStatus(item).text }}</span>
                  </span>
                </span>
                <span class="muted cell" role="gridcell">{{ formatBytes(item.size) }}</span>
                <span class="col-date cell" role="gridcell"><span class="gbar"><span :style="{ width: `${Math.floor(ghostPercent(item) * 100)}%` }" /></span></span>
                <button type="button" class="dots" :aria-label="t('explorer.ghostActions', { name: item.name })" @click.stop="openMenuFor($event, ghostMenu(item), item.name)"><AppIcon name="more" /></button>
              </li>
              <li
                v-for="entry in sorted"
                :key="entry.name"
                class="row item"
                role="row"
                :style="{ order: entry.type === 'dir' ? 0 : 2 }"
                :tabindex="focused === entry.name || (focused === null && entry === sorted[0]) ? 0 : -1"
                :data-entry="entry.name"
                :aria-selected="selection.has(entry.name)"
                :class="{ selected: selection.has(entry.name), cut: isCut(entry), drop: dropTarget === pathOf(entry.name) }"
                :draggable="canWrite"
                @click.stop="onItemClick($event, entry)"
                @dblclick="lastPointer !== 'touch' && openEntry(entry)"
                @contextmenu.stop="onItemContext($event, entry)"
                @dragstart="onItemDragStart($event, entry)"
                @dragover="entry.type === 'dir' && onFolderDragOver($event, pathOf(entry.name))"
                @dragleave="dropTarget = null"
                @drop="entry.type === 'dir' && onFolderDrop($event, pathOf(entry.name))"
              >
                <span class="name" role="gridcell">
                  <span v-if="touchSelecting" class="check" :class="{ on: selection.has(entry.name) }" aria-hidden="true"><AppIcon v-if="selection.has(entry.name)" name="check" :size="16" /></span>
                  <AppIcon :name="fileKind(entry.name, entry.type).icon" :size="22" :class="iconClass(entry)" />
                  <span class="label">
                    <span class="text">{{ entry.name }}</span>
                    <span v-if="!entry.portable" class="issue"><AppIcon name="alert" :size="13" :stroke="2" />{{ serverText(entry.issue ?? '') }}</span>
                  </span>
                </span>
                <span class="muted cell" role="gridcell">{{ entry.type === 'dir' ? '—' : formatBytes(entry.size) }}</span>
                <span class="muted cell col-date" role="gridcell">{{ formatDate(entry.mtime) }}</span>
                <button type="button" class="dots" :aria-label="t('explorer.itemActions', { name: entry.name })" tabindex="-1" @click.stop="onItemContext($event, entry)"><AppIcon name="more" /></button>
              </li>
            </ul>
          </div>

          <ul v-else class="grid" :class="`size-${gridSize}`" role="listbox" aria-multiselectable="true" :aria-label="t('explorer.gridItems')">
            <li
              v-for="item in ghosts"
              :key="`up-${item.id}`"
              class="tile ghost"
              :class="`g-${item.state}`"
              style="order: 1"
              :aria-label="`${item.name}: ${ghostStatus(item).text}`"
              @contextmenu.prevent.stop="openMenuFor($event, ghostMenu(item), item.name)"
              @click.stop="openMenuFor($event, ghostMenu(item), item.name)"
            >
              <span class="thumb">
                <img v-if="localPreview(item)" :src="localPreview(item) ?? ''" alt="" loading="lazy" decoding="async" draggable="false">
                <AppIcon v-else :name="fileKind(item.name, 'file').icon" :size="44" :stroke="1.4" class="ico-doc" />
                <span class="ghost-veil">
                  <ProgressRing :value="item.state === 'queued' && item.uploaded === 0 ? null : ghostPercent(item)" :size="54" :stroke="4" :tone="ghostStatus(item).tone" />
                  <span class="ghost-pct">{{ item.state === 'done' ? '✓' : `${Math.floor(ghostPercent(item) * 100)}%` }}</span>
                </span>
              </span>
              <span class="tile-name">{{ item.finalName ?? item.name }}</span>
              <span class="tile-meta gstatus" :class="`t-${ghostStatus(item).tone}`">{{ ghostStatus(item).text }}</span>
            </li>
            <li
              v-for="entry in sorted"
              :key="entry.name"
              class="tile"
              role="option"
              :style="{ order: entry.type === 'dir' ? 0 : 2 }"
              :tabindex="focused === entry.name || (focused === null && entry === sorted[0]) ? 0 : -1"
              :data-entry="entry.name"
              :aria-selected="selection.has(entry.name)"
              :class="{ selected: selection.has(entry.name), cut: isCut(entry), drop: dropTarget === pathOf(entry.name) }"
              :draggable="canWrite"
              :title="entry.name"
              @click.stop="onItemClick($event, entry)"
              @dblclick="lastPointer !== 'touch' && openEntry(entry)"
              @contextmenu.stop="onItemContext($event, entry)"
              @dragstart="onItemDragStart($event, entry)"
              @dragover="entry.type === 'dir' && onFolderDragOver($event, pathOf(entry.name))"
              @dragleave="dropTarget = null"
              @drop="entry.type === 'dir' && onFolderDrop($event, pathOf(entry.name))"
            >
              <span class="thumb">
                <img
                  v-if="showThumb(entry)"
                  :src="thumbSrc(entry, THUMB_PX[gridSize])"
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable="false"
                  @error="markBroken(entry.name)"
                >
                <AppIcon v-else :name="fileKind(entry.name, entry.type).icon" :size="44" :stroke="1.4" :class="iconClass(entry)" />
                <span v-if="viewerKind(entry.name) === 'video' && showThumb(entry)" class="badge-play" aria-hidden="true"><AppIcon name="play" :size="14" /></span>
                <span v-if="touchSelecting" class="check corner" :class="{ on: selection.has(entry.name) }" aria-hidden="true"><AppIcon v-if="selection.has(entry.name)" name="check" :size="16" /></span>
              </span>
              <span class="tile-name">{{ entry.name }}</span>
              <span class="muted tile-meta">{{ entry.type === 'dir' ? t('common.folder') : formatBytes(entry.size) }}</span>
            </li>
          </ul>

          <div v-if="nextCursor !== null" class="more">
            <span class="muted">{{ t('explorer.showing', { n: entries.length, total }) }}</span>
            <button type="button" class="btn" :disabled="loadingMore" @click.stop="loadMore">{{ loadingMore ? t('common.loading') : t('explorer.loadMore') }}</button>
          </div>

          <div v-if="canWrite" class="dropzone muted" :class="{ dragging }">
            <AppIcon name="upload" :size="20" />
            <span>{{ t('explorer.dropzone') }} <strong>{{ folderName }}</strong></span>
          </div>
        </template>
      </section>

      <div v-if="detailsSheet" class="sheet-backdrop" aria-hidden="true" @click="detailsSheet = false" />
      <aside v-if="!loading && entries.length > 0 && (detailsOpen || detailsSheet)" :aria-label="t('explorer.itemDetails')" class="card details" :class="{ sheet: detailsSheet }">
        <button type="button" class="d-close" :aria-label="t('explorer.closeDetails')" :title="t('explorer.closeDetails')" @click="detailsSheet ? (detailsSheet = false) : (detailsOpen = false)"><AppIcon name="close" :size="16" /></button>
        <template v-if="single">
          <div class="preview">
            <img v-if="showThumb(single)" :src="thumbSrc(single, 640)" alt="" @error="markBroken(single.name)">
            <AppIcon v-else :name="fileKind(single.name, single.type).icon" :size="48" :stroke="1.4" :class="iconClass(single)" />
          </div>
          <div>
            <h2 class="d-name selectable">{{ single.name }}</h2>
            <p class="muted">{{ fileKind(single.name, single.type).label }}</p>
          </div>
          <p v-if="!single.portable" class="notice notice-warn">{{ t('explorer.notPortableNotice', { issue: serverText(single.issue ?? '') }) }}</p>
          <dl class="kv">
            <template v-if="single.type === 'file'">
              <dt>{{ t('explorer.colSize') }}</dt>
              <dd>{{ formatBytes(single.size) }}</dd>
            </template>
            <dt>{{ t('explorer.colModified') }}</dt>
            <dd>{{ formatDate(single.mtime) }}</dd>
            <dt>{{ t('explorer.location') }}</dt>
            <dd class="mono selectable">{{ pathOf(single.name) }}</dd>
          </dl>
          <div class="d-actions">
            <button type="button" class="btn btn-primary" @click="openEntry(single)"><AppIcon :name="single.type === 'dir' ? 'folder' : 'eye'" :size="16" />{{ t('explorer.open') }}</button>
            <button type="button" class="btn" @click="download([single])"><AppIcon :name="single.type === 'dir' ? 'archive' : 'download'" :size="16" />{{ single.type === 'dir' ? 'ZIP' : t('explorer.download') }}</button>
            <button type="button" class="btn btn-icon" :aria-label="t('explorer.moreActions')" @click="onItemContext($event, single)"><AppIcon name="more" /></button>
          </div>
        </template>
        <template v-else-if="selected.length > 1">
          <div class="preview"><AppIcon name="copy" :size="44" :stroke="1.4" class="muted" /></div>
          <h2 class="d-name">{{ t('explorer.items', { n: selected.length }) }}</h2>
          <p class="muted">{{ t('explorer.selectionBytes', { size: formatBytes(selectedBytes), dirs: selected.some((e) => e.type === 'dir') ? 1 : 0 }) }}</p>
          <div class="d-actions">
            <button type="button" class="btn" @click="download(selected)"><AppIcon name="archive" />{{ t('explorer.downloadZip') }}</button>
            <button type="button" class="btn btn-danger" :disabled="!canWrite" @click="trash(selected)"><AppIcon name="trash" />{{ t('explorer.trash') }}</button>
          </div>
        </template>
        <p v-else class="muted">{{ t('explorer.detailsEmpty') }}</p>
      </aside>
    </div>

    <FileViewer
      v-if="viewerName !== null && viewerIndex >= 0"
      :items="files"
      :index="viewerIndex"
      :dir="clientPath"
      @close="closeViewer"
      @navigate="(index) => { viewerName = (files[index] as FsEntry).name; selectOnly(viewerName); }"
      @trash="(entry) => trash([entry])"
    />
  </div>
</template>

<style scoped>
.explorer {
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
}

.crumbs {
  font-size: 13px;
}

.crumbs ol {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.crumb {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 6px;
  border-radius: 6px;
  color: var(--accent);
  font-weight: 500;
  text-decoration: none;
}

.crumb.here {
  color: var(--text);
}

.crumb.drop {
  background: var(--accent-soft);
  outline: 2px dashed var(--accent);
}

.sep {
  display: inline-flex;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  margin-right: auto;
  min-width: 0;
}

h1 {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
  overflow-wrap: anywhere;
}

h2 {
  font-size: 16px;
  font-weight: 600;
}

.count {
  font-size: 13px;
}

.sorter {
  display: flex;
  gap: 4px;
}

.search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  width: 180px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  transition: width 0.18s ease, border-color 0.18s ease;
}

.search:focus-within,
.search.active {
  width: 240px;
  border-color: var(--accent);
}

.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: none;
  font-size: 14px;
}

.search input::-webkit-search-cancel-button {
  display: none;
}

.search .clear {
  display: inline-flex;
  border: 0;
  background: none;
  color: var(--muted);
  padding: 4px;
}

.select {
  min-height: 40px;
  padding: 0 10px;
}

.views {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}

.views button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 38px;
  border: 0;
  background: var(--surface);
  color: var(--muted);
}

.views button.on {
  background: var(--accent-soft);
  color: var(--accent);
}

/* Barra de selección flotante: no desplaza el contenido (sin saltos al seleccionar). */
.selbar {
  position: fixed;
  z-index: 40;
  left: 50%;
  bottom: calc(24px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  width: max-content;
  max-width: calc(100vw - 24px);
  padding: 6px 8px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  animation: selbar-in 0.16s ease-out;
}

@keyframes selbar-in {
  from {
    opacity: 0;
    transform: translate(-50%, 10px);
  }
}

.selbar strong {
  padding: 0 6px;
  white-space: nowrap;
}

.selbar .grow {
  width: 8px;
}

.selbar .danger {
  color: var(--danger);
}

.columns {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  flex: 1;
}

.listing {
  flex: 1;
  align-self: stretch;
  min-width: 0;
  min-height: calc(100vh - 240px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-radius: 14px;
}

.listing.dragging {
  outline: 2px dashed var(--accent);
  outline-offset: 4px;
}

.skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* Entra con un fundido y un pequeño retraso: si la carga es rápida, ni se llega a ver. */
  animation: skeleton-in 0.25s ease-out 0.15s both;
}

@keyframes skeleton-in {
  from {
    opacity: 0;
  }
}

/* Lista de la carpeta anterior mientras llega la nueva: no responde a clics y, si tarda, se atenúa. */
.listing.stale {
  pointer-events: none;
}

.listing.stale > * {
  opacity: 0.55;
  transition: opacity 0.15s ease 0.12s;
}

.skeleton li {
  height: 48px;
  border-radius: 10px;
  background: var(--surface-2);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.55;
  }
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 20px;
  text-align: center;
}

.empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 6px;
}

.table ul {
  display: flex;
  flex-direction: column;
}

.table {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 110px 180px 40px;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 14px;
  min-height: 48px;
  border-bottom: 1px solid var(--border);
}

.row.head {
  min-height: 38px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--surface-2);
}

.hcell {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  text-transform: inherit;
  letter-spacing: inherit;
  text-align: left;
}

.row.item {
  outline: none;
  cursor: default;
}

.row.item:last-child {
  border-bottom: 0;
}

.row.item:hover {
  background: var(--surface-2);
}

.row.item:focus-visible {
  box-shadow: inset 0 0 0 2px var(--accent);
}

.row.item.selected {
  background: var(--accent-soft);
}

.row.item.cut,
.tile.cut {
  opacity: 0.55;
}

.row.item.drop,
.tile.drop {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 2px var(--accent);
}

.name {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.label {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.text {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.issue {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--warn);
}

.cell {
  font-size: 13px;
  white-space: nowrap;
}

.dots {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--muted);
  opacity: 0;
}

.row.item:hover .dots,
.row.item.selected .dots {
  opacity: 1;
}

.check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  background: var(--surface);
  color: #ffffff;
}

.check.on {
  background: var(--accent-btn);
  border-color: var(--accent-btn);
}

.check.corner {
  position: absolute;
  top: 8px;
  left: 8px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
}

.grid.size-sm {
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
}

.grid.size-sm .tile {
  padding: 6px 6px 8px;
}

.grid.size-sm .tile-name {
  font-size: 12px;
}

.grid.size-sm .tile-meta {
  display: none;
}

.grid.size-lg {
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
  gap: 12px;
}

.tile {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 8px 10px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  outline: none;
  cursor: default;
}

.tile:hover {
  border-color: var(--border-strong);
}

.tile:focus-visible {
  box-shadow: 0 0 0 2px var(--accent);
}

.tile.selected {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  border-radius: 10px;
  background: var(--surface-2);
  overflow: hidden;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.badge-play {
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: inline-flex;
  padding: 5px;
  border-radius: 50%;
  background: rgb(0 0 0 / 55%);
  color: #ffffff;
}

.tile-name {
  font-weight: 500;
  font-size: 13px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow-wrap: anywhere;
}

.tile-meta {
  font-size: 12px;
}

.more {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dropzone {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px;
  border: 1px dashed var(--border-strong);
  border-radius: 14px;
  font-size: 13px;
}

.dropzone.dragging {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.details {
  position: sticky;
  padding-top: 22px !important;
  top: 12px;
  width: 300px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
}

.preview {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  border-radius: 12px;
  background: var(--surface-2);
  overflow: hidden;
}

.preview img {
  width: 100%;
  max-height: 220px;
  object-fit: contain;
}

.d-name {
  overflow-wrap: anywhere;
}

.d-actions {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
}

.d-actions .btn {
  min-height: 36px;
  padding: 0 12px;
  font-size: 13px;
  gap: 6px;
  white-space: nowrap;
}

.d-actions .btn:not(.btn-icon) {
  flex: 1;
  justify-content: center;
}

.d-actions .btn-icon {
  width: 36px;
  flex: none;
}

/* Subidas en curso: translúcidas, con anillo de progreso, hasta que el archivo está guardado. */
.ghost {
  cursor: default;
}

.row.ghost {
  background: linear-gradient(90deg, var(--accent-soft), transparent 70%);
}

.ghost .text,
.ghost .thumb > img,
.ghost .thumb > .icon {
  opacity: 0.55;
}

.ghost.g-done .text,
.ghost.g-done .thumb > img {
  opacity: 0.9;
  transition: opacity 0.4s ease;
}

.ghost-ico {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex: none;
}

.ghost-ring {
  position: absolute;
  inset: 0;
}

.gstatus {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gstatus.t-accent {
  color: var(--accent);
}

.gstatus.t-warn {
  color: var(--warn);
}

.gstatus.t-danger {
  color: var(--danger);
}

.gstatus.t-ok {
  color: var(--ok);
}

.gbar {
  display: block;
  height: 6px;
  border-radius: 3px;
  background: var(--track);
  overflow: hidden;
}

.gbar span {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--accent-btn);
  transition: width 0.35s ease;
}

.g-waiting .gbar span {
  background: var(--warn);
}

.g-error .gbar span {
  background: var(--danger);
}

.tile.ghost {
  border-style: dashed;
}

.ghost-veil {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--surface) 35%, transparent);
  backdrop-filter: blur(1.5px);
}

.ghost-pct {
  position: absolute;
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.g-uploading .ghost-veil {
  animation: breathe 2s ease-in-out infinite;
}

@keyframes breathe {
  50% {
    background: color-mix(in srgb, var(--surface) 20%, transparent);
  }
}

.d-close {
  position: absolute;
  top: 10px;
  right: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 10px;
  background: none;
  color: var(--muted);
}

.d-close:hover {
  background: var(--surface-2);
}

.sheet-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgb(15 18 23 / 45%);
}

@media (max-width: 1100px) {
  .details,
  .details-toggle {
    display: none;
  }

  .details.sheet {
    display: flex;
    position: fixed;
    z-index: 61;
    left: 0;
    right: 0;
    bottom: 0;
    top: auto;
    width: 100%;
    max-height: 80vh;
    overflow-y: auto;
    border-radius: 22px 22px 0 0;
    padding-bottom: calc(18px + env(safe-area-inset-bottom));
    animation: sheet-up 0.22s cubic-bezier(0.2, 0.9, 0.3, 1);
  }
}

@media (max-width: 820px) {
  .selbar {
    bottom: calc(var(--tabbar-h) + 12px + var(--toast-lift, 0px));
    transition: bottom 0.18s ease;
  }
}

@media (max-width: 720px) {
  /* Móvil: «Subir» como botón flotante sobre la barra de pestañas. */
  .upload-btn {
    position: fixed;
    z-index: 35;
    right: 18px;
    bottom: calc(var(--tabbar-h) + 18px + var(--toast-lift, 0px));
    transition: bottom 0.18s ease, transform 0.18s ease;
    width: 58px;
    height: 58px;
    padding: 0;
    border-radius: 18px;
    justify-content: center;
    box-shadow: 0 10px 24px rgb(36 87 214 / 40%);
  }

  /* En el móvil no se arrastran archivos: se sube con el botón flotante. */
  .dropzone:not(.dragging) {
    display: none;
  }

  .upload-btn.fab-hidden {
    transform: scale(0);
  }

  .upload-btn span {
    display: none;
  }

  .search,
  .search:focus-within,
  .search.active {
    order: 10;
    width: 100%;
    height: 44px;
  }

  .search input {
    font-size: 16px;
  }

  .heading {
    flex: 1 1 0;
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
  }

  .heading h1 {
    max-width: 100%;
    font-size: 22px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    overflow-wrap: normal;
  }

  .row {
    grid-template-columns: minmax(0, 1fr) 80px 40px;
  }

  .col-date,
  .hide-sm {
    display: none;
  }

  .dots {
    opacity: 1;
  }

  .grid {
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  }

  .grid.size-sm {
    grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  }

  .grid.size-lg {
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 8px;
  }
}

@media (max-width: 420px) {
  .hide-xs {
    display: none;
  }
}

@media (pointer: coarse) {
  .dots {
    opacity: 1;
  }

  .row {
    min-height: 56px;
  }
}
</style>
