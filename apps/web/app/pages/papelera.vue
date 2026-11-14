<script setup lang="ts">
import type { BatchResponse, TrashEntry, TrashListResponse, TrashPurgeResponse } from '@pcloud/contracts';

useHead({ title: () => t('trash.pageTitle') });
const session = useSession();
const storage = useStorage();

const data = ref<TrashListResponse | null>(null);
const loading = ref(true);
const failure = liveText();
const selection = ref<Set<string>>(new Set());
const isOwner = computed(() => session.user.value?.role === 'owner');
const canWrite = computed(() => storage.writable.value);
const entries = computed(() => data.value?.entries ?? []);
const selected = computed(() => entries.value.filter((entry) => selection.value.has(entry.id)));
let lastPointer = 'mouse';

async function load(): Promise<void> {
  loading.value = data.value === null;
  failure.value = '';
  try {
    data.value = await api<TrashListResponse>('/trash');
    const ids = new Set(data.value.entries.map((entry) => entry.id));
    selection.value = new Set([...selection.value].filter((id) => ids.has(id)));
  } catch (error) {
    failure.value = errorText(error instanceof ApiError ? error : null, 'trash.loadFailed');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(storage.readable, (now, before) => {
  if (now && !before) void load();
});

function originLabel(entry: TrashEntry): string {
  if (entry.originalPath === null) return t('trash.unknownOrigin');
  const parent = entry.originalPath.split('/').slice(0, -1).join('/');
  return parent === '' ? t('common.files') : `${t('common.files')}${parent}`;
}

function daysLeft(entry: TrashEntry): string {
  if (entry.expiresAt === null) return '';
  const days = Math.ceil((Date.parse(entry.expiresAt) - Date.now()) / 86_400_000);
  return days <= 0 ? t('trash.deletedToday') : t('trash.daysLeft', { n: days });
}

function onClick(event: MouseEvent, entry: TrashEntry): void {
  const next = new Set(lastPointer === 'touch' || event.ctrlKey || event.metaKey ? selection.value : []);
  if (next.has(entry.id) && (lastPointer === 'touch' || event.ctrlKey || event.metaKey)) next.delete(entry.id);
  else next.add(entry.id);
  selection.value = next;
}

async function restore(list: TrashEntry[]): Promise<void> {
  if (list.length === 0) return;
  try {
    const response = await api<BatchResponse>('/trash/restore', { method: 'POST', body: { ids: list.map((entry) => entry.id) } });
    const ok = response.results.filter((item) => item.ok);
    const failed = response.results.filter((item) => !item.ok);
    if (ok.length > 0) {
      const first = ok[0];
      toast(ok.length === 1 && first?.ok ? t('trash.restoredIn', { path: first.path }) : t('trash.restoredMany', { n: ok.length }), {
        tone: 'ok',
        ...(ok.length === 1 && first?.ok ? { action: { label: t('trash.openFolder'), run: () => void navigateTo(explorerLink(first.path.split('/').filter(Boolean).slice(0, -1))) } } : {}),
      });
    }
    if (failed.length > 0) toast(t('trash.restoreFailedSome', { n: failed.length, message: failed[0]?.ok === false ? localizeServerError(failed[0].code, failed[0].message) : '' }), { tone: 'danger' });
    selection.value = new Set();
    await load();
  } catch (error) {
    toast(error instanceof ApiError ? error.message : t('trash.restoreFailed'), { tone: 'danger' });
  }
}

async function purge(list: TrashEntry[]): Promise<void> {
  if (list.length === 0 || !isOwner.value) return;
  const ok = await confirmDialog({
    title: list.length === 1 ? t('trash.purgeOneTitle', { name: list[0]?.name ?? '' }) : t('trash.purgeManyTitle', { n: list.length }),
    message: t('trash.purgeMessage'),
    confirm: t('trash.deletePermanently'),
    danger: true,
  });
  if (!ok) return;
  try {
    const result = await api<TrashPurgeResponse>('/trash/delete', { method: 'POST', body: { ids: list.map((entry) => entry.id) }, timeoutMs: 0 });
    toast(result.removed === 1 ? t('trash.purgedOne') : t('trash.purgedMany', { n: result.removed }), { tone: 'ok' });
    selection.value = new Set();
    await load();
  } catch (error) {
    toast(error instanceof ApiError ? error.message : t('trash.deleteFailed'), { tone: 'danger' });
  }
}

async function empty(): Promise<void> {
  if (!isOwner.value || entries.value.length === 0) return;
  const ok = await confirmDialog({
    title: t('trash.emptyTitle'),
    message: t('trash.emptyMessage', { n: entries.value.length, size: formatBytes(data.value?.totalBytes ?? 0) }),
    confirm: t('trash.emptyTrash'),
    danger: true,
  });
  if (!ok) return;
  try {
    const result = await api<TrashPurgeResponse>('/trash/empty', { method: 'POST', timeoutMs: 0 });
    toast(t('trash.emptied', { n: result.removed }), { tone: 'ok' });
    await load();
  } catch (error) {
    toast(error instanceof ApiError ? error.message : t('trash.emptyFailed'), { tone: 'danger' });
  }
}

const notOwner = (): string => t('trash.notOwner');

function itemMenu(entry: TrashEntry): MenuItem[] {
  if (!selection.value.has(entry.id)) selection.value = new Set([entry.id]);
  const list = selected.value;
  const many = list.length > 1;
  return [
    { label: many ? t('trash.restoreMany', { n: list.length }) : t('trash.restore'), icon: 'undo', disabled: !canWrite.value, run: () => void restore(list) },
    ...(!many && entry.originalPath !== null
      ? [{ label: t('trash.openOriginalFolder'), icon: 'folder' as const, run: () => void navigateTo(explorerLink((entry.originalPath ?? '').split('/').filter(Boolean).slice(0, -1))) }]
      : []),
    { label: many ? t('trash.deleteManyPermanently', { n: list.length }) : t('trash.deletePermanently'), icon: 'trash-x', danger: true, separator: true, disabled: !isOwner.value || !canWrite.value, hint: notOwner(), run: () => void purge(list) },
  ];
}

function backgroundMenu(): MenuItem[] {
  return [
    { label: t('trash.selectAll'), icon: 'check-all', disabled: entries.value.length === 0, run: () => (selection.value = new Set(entries.value.map((entry) => entry.id))) },
    { label: t('trash.refresh'), icon: 'refresh', run: () => void load() },
    { label: t('trash.emptyTrash'), icon: 'trash-x', danger: true, separator: true, disabled: !isOwner.value || entries.value.length === 0 || !canWrite.value, hint: notOwner(), run: () => void empty() },
  ];
}

const longPress = useLongPress((point) => {
  const target = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('[data-id]');
  const entry = entries.value.find((item) => item.id === target?.dataset['id']);
  if (entry === undefined) openMenuFor(point, backgroundMenu(), t('trash.title'));
  else openMenuFor(point, itemMenu(entry), entry.name);
});

function onKeydown(event: KeyboardEvent): void {
  if (event.target instanceof Element && event.target.closest('input, dialog, [role="menu"]') !== null) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    selection.value = new Set(entries.value.map((entry) => entry.id));
  } else if (event.key === 'Delete' && selected.value.length > 0) {
    void purge(selected.value);
  } else if (event.key === 'Escape') {
    selection.value = new Set();
  } else return;
  event.preventDefault();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="page" @pointerdown.capture="lastPointer = $event.pointerType">
    <div class="toolbar">
      <div class="heading">
        <h1>{{ t('trash.title') }}</h1>
        <span v-if="data" class="muted">{{ t('trash.items', { n: entries.length }) }} · {{ formatBytes(data.totalBytes) }}</span>
      </div>
      <button type="button" class="btn" :disabled="selected.length === 0 || !canWrite" @click="restore(selected)"><AppIcon name="undo" />{{ t('trash.restore') }}</button>
      <button v-if="isOwner" type="button" class="btn btn-danger" :disabled="entries.length === 0 || !canWrite" @click="empty"><AppIcon name="trash-x" />{{ t('trash.emptyShort') }}</button>
    </div>

    <p class="notice notice-info">
      <AppIcon name="info" class="accent" />
      <span>{{ data?.retentionDays ? t('trash.noticeRetention', { days: data.retentionDays }) : t('trash.notice') }}</span>
    </p>

    <DiskUnavailable v-if="storage.known.value && !storage.readable.value" />
    <section v-else-if="failure" class="card empty"><p>{{ failure }}</p><button type="button" class="btn" @click="load">{{ t('common.retry') }}</button></section>
    <ul v-else-if="loading" class="skeleton" aria-hidden="true"><li v-for="n in 4" :key="n" /></ul>
    <section v-else-if="entries.length === 0" class="card empty">
      <AppIcon name="trash" :size="44" :stroke="1.4" class="muted" />
      <h2>{{ t('trash.isEmpty') }}</h2>
      <p class="muted">{{ t('trash.isEmptyHint') }}</p>
    </section>
    <div
      v-else
      class="table"
      role="grid"
      aria-multiselectable="true"
      @contextmenu.self.prevent="openMenuFor($event, backgroundMenu(), t('trash.title'))"
      @touchstart.passive="longPress.onTouchstart"
      @touchmove.passive="longPress.onTouchmove"
      @touchend="longPress.onTouchend"
    >
      <div class="row head muted" role="row"><span>{{ t('trash.colName') }}</span><span class="hide-sm">{{ t('trash.colOrigin') }}</span><span class="hide-sm">{{ t('trash.colDeleted') }}</span><span>{{ t('trash.colSize') }}</span></div>
      <ul>
        <li
          v-for="entry in entries"
          :key="entry.id"
          class="row item"
          role="row"
          tabindex="0"
          :data-id="entry.id"
          :aria-selected="selection.has(entry.id)"
          :class="{ selected: selection.has(entry.id) }"
          @click="onClick($event, entry)"
          @dblclick="restore([entry])"
          @keydown.enter="restore([entry])"
          @contextmenu.prevent.stop="openMenuFor($event, itemMenu(entry), entry.name)"
        >
          <span class="name">
            <AppIcon :name="fileKind(entry.name, entry.type).icon" :size="22" :class="entry.type === 'dir' ? 'ico-folder' : 'ico-doc'" />
            <span class="label"><span class="text">{{ entry.name }}</span><span class="muted sub">{{ daysLeft(entry) }}</span></span>
          </span>
          <span class="muted cell hide-sm">{{ originLabel(entry) }}</span>
          <span class="muted cell hide-sm">{{ formatDate(entry.deletedAt) }}</span>
          <span class="muted cell">{{ formatBytes(entry.size) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
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
}

h1 {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 20px;
  text-align: center;
}

.skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skeleton li {
  height: 52px;
  border-radius: 10px;
  background: var(--surface-2);
}

.table {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
  min-height: 200px;
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 0.8fr) 170px 100px;
  gap: 10px;
  align-items: center;
  min-height: 54px;
  padding: 0 14px;
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

.row.item {
  outline: none;
}

.row.item:hover {
  background: var(--surface-2);
}

.row.item.selected {
  background: var(--accent-soft);
}

.row.item:focus-visible {
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

.sub {
  font-size: 12px;
}

.cell {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 720px) {
  .row {
    grid-template-columns: minmax(0, 1fr) 80px;
  }

  .hide-sm {
    display: none;
  }
}
</style>
