<script setup lang="ts">
import type { ActivityEntry, ActivityResponse } from '@pcloud/contracts';

useHead({ title: () => t('activity.pageTitle') });
const session = useSession();

const FILTERS = computed<Array<{ value: string; label: string }>>(() => [
  { value: '', label: t('activity.filterAll') },
  { value: 'fs.', label: t('activity.filterFiles') },
  { value: 'trash.', label: t('activity.filterTrash') },
  { value: 'auth.', label: t('activity.filterAuth') },
  { value: 'users.', label: t('activity.filterUsers') },
  { value: 'share.', label: t('activity.filterShares') },
]);

/** Texto de una acción de auditoría: «auth.passkey.login» → activity.authPasskeyLogin (si no hay, la acción tal cual). */
function actionLabel(action: string): string {
  const key = `activity.${action.split('.').map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))).join('')}`;
  return hasMessage(key) ? t(key) : action;
}

const filter = ref('');
const entries = ref<ActivityEntry[]>([]);
const nextBefore = ref<number | null>(null);
const loading = ref(false);
const failure = liveText();

let requestId = 0;

async function load(more = false): Promise<void> {
  const current = ++requestId;
  loading.value = true;
  failure.value = '';
  try {
    const page = await api<ActivityResponse>('/activity', {
      query: { limit: 60, action: filter.value === '' ? undefined : filter.value, before: more ? (nextBefore.value ?? undefined) : undefined },
    });
    if (current !== requestId) return;
    entries.value = more ? [...entries.value, ...page.entries] : page.entries;
    nextBefore.value = page.nextBefore;
  } catch (error) {
    failure.value = errorText(error instanceof ApiError ? error : null, 'activity.loadFailed');
  } finally {
    loading.value = false;
  }
}

watch(filter, () => void load(), { immediate: true });

const groups = computed(() => {
  const byDay = new Map<string, ActivityEntry[]>();
  const fmt = dateFormat({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  for (const entry of entries.value) {
    const day = fmt.format(new Date(entry.at));
    byDay.set(day, [...(byDay.get(day) ?? []), entry]);
  }
  return [...byDay.entries()];
});

const time = (iso: string): string => dateFormat({ hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

function icon(action: string): IconName {
  if (action.startsWith('auth.passkey')) return 'fingerprint';
  if (action.startsWith('auth') || action.startsWith('setup')) return 'lock';
  if (action.startsWith('users')) return 'users';
  if (action === 'share.download') return 'download';
  if (action.startsWith('share')) return 'link';
  if (action.startsWith('trash')) return 'trash';
  if (action === 'fs.upload') return 'upload';
  if (action === 'fs.download' || action === 'fs.zip') return 'download';
  if (action === 'fs.trash') return 'trash';
  if (action === 'fs.rename') return 'edit';
  if (action === 'fs.move') return 'move';
  if (action === 'fs.copy') return 'copy';
  if (action === 'fs.play') return 'play';
  if (action.startsWith('system')) return 'drive';
  return 'folder';
}

/**
 * El servidor guarda el detalle como texto (en español). Los formatos conocidos se reescriben en
 * el idioma activo y con el plural correcto; el resto (nombres, rutas) se muestra tal cual.
 */
function prettyDetail(detail: string): string {
  let m: RegExpMatchArray | null;
  if ((m = detail.match(/^(\d+) bytes$/))) return formatBytes(Number(m[1]));
  if ((m = detail.match(/^(\d+) elementos eliminados definitivamente$/))) return t('activity.detailPurged', { n: Number(m[1]) });
  if ((m = detail.match(/^(\d+) elementos en total$/))) return t('activity.detailItemsTotal', { n: Number(m[1]) });
  if ((m = detail.match(/^(\d+) elementos$/))) return t('activity.detailItems', { n: Number(m[1]) });
  if ((m = detail.match(/^escritura ([\d.]+) MB\/s · lectura ([\d.]+) MB\/s · (\d+) IOPS$/))) {
    return t('activity.detailSpeed', { write: formatNumber(Number(m[1])), read: formatNumber(Number(m[2])), iops: formatNumber(Number(m[3]), 0) });
  }
  if ((m = detail.match(/^usuario (\d+)$/))) return t('activity.detailUser', { id: m[1]! });
  if (detail === 'contraseña incorrecta') return t('activity.detailWrongPassword');
  if (/^enlace [a-z0-9]{12}( · |$)/.test(detail)) {
    return detail
      .split(' · ')
      .map((part) => {
        let p: RegExpMatchArray | null;
        if ((p = part.match(/^enlace ([a-z0-9]{12})$/))) return t('activity.detailShare', { id: p[1]! });
        if ((p = part.match(/^(\d+) d$/))) return t('activity.detailDays', { n: Number(p[1]) });
        if (part === 'con contraseña') return t('activity.detailWithPassword');
        if ((p = part.match(/^máx\. (\d+) descargas$/))) return t('activity.detailMaxDownloads', { n: Number(p[1]) });
        return part;
      })
      .join(' · ');
  }
  if (detail === 'llave desconocida') return t('activity.detailUnknownKey');
  return detail;
}

function openFolder(entry: ActivityEntry): void {
  if (entry.path === null || !entry.path.startsWith('/')) return;
  const target = entry.action === 'fs.mkdir' ? entry.path : entry.path.split('/').slice(0, -1).join('/');
  void navigateTo(explorerLink(target.split('/').filter(Boolean)));
}

function menu(entry: ActivityEntry): MenuItem[] {
  return [
    { label: t('activity.openFolder'), icon: 'folder', disabled: entry.path === null || !entry.path.startsWith('/'), run: () => openFolder(entry) },
    { label: t('activity.copyPath'), icon: 'link', disabled: entry.path === null, run: () => void navigator.clipboard.writeText(entry.path ?? '').then(() => toast(t('activity.pathCopied'), { tone: 'ok' })) },
    { label: t('activity.refresh'), icon: 'refresh', separator: true, run: () => void load() },
  ];
}
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <div class="heading">
        <h1>{{ t('activity.title') }}</h1>
        <span class="muted">{{ session.user.value?.role === 'owner' ? t('activity.allUsers') : t('activity.yours') }}</span>
      </div>
      <button type="button" class="btn btn-icon" :aria-label="t('activity.refresh')" :title="t('activity.refresh')" @click="load()"><AppIcon name="refresh" /></button>
    </div>

    <div class="chips" role="radiogroup" :aria-label="t('activity.filter')">
      <button v-for="item in FILTERS" :key="item.value" type="button" role="radio" class="chip-btn" :aria-checked="filter === item.value" @click="filter = item.value">{{ item.label }}</button>
    </div>

    <p v-if="failure" class="notice notice-danger">{{ failure }}</p>
    <section v-else-if="!loading && entries.length === 0" class="card empty">
      <AppIcon name="clock" :size="40" :stroke="1.4" class="muted" />
      <p class="muted">{{ t('activity.empty') }}</p>
    </section>

    <section v-for="[day, items] in groups" :key="day" class="card day">
      <h2>{{ day }}</h2>
      <ul>
        <li v-for="entry in items" :key="entry.id" class="ev" :class="{ denied: entry.result !== 'ok' }" @contextmenu.prevent="openMenuFor($event, menu(entry), actionLabel(entry.action))" @dblclick="openFolder(entry)">
          <span class="ev-ico"><AppIcon :name="icon(entry.action)" :size="18" /></span>
          <span class="ev-body">
            <span>
              <strong>{{ actionLabel(entry.action) }}</strong>
              <span v-if="entry.result !== 'ok'" class="tag">{{ entry.result === 'denied' ? t('activity.denied') : t('activity.error') }}</span>
            </span>
            <span v-if="entry.path" class="mono path selectable">{{ entry.path }}</span>
            <span v-if="entry.detail" class="muted small selectable">{{ prettyDetail(entry.detail) }}</span>
          </span>
          <span class="ev-meta muted">
            <span>{{ time(entry.at) }}</span>
            <span v-if="entry.username" class="small">{{ entry.username }}</span>
            <span v-if="entry.ip" class="small mono">{{ entry.ip }}</span>
          </span>
        </li>
      </ul>
    </section>

    <button v-if="nextBefore !== null" type="button" class="btn" :disabled="loading" @click="load(true)">{{ loading ? t('common.loading') : t('activity.more') }}</button>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 980px;
}

.toolbar {
  display: flex;
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

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip-btn {
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  font-size: 13px;
  font-weight: 500;
}

.chip-btn[aria-checked='true'] {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 36px;
}

.day {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.day h2 {
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
}

.day h2::first-letter {
  text-transform: uppercase;
}

.ev {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
  padding: 10px 0;
  border-top: 1px solid var(--border);
}

.ev-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
}

.denied .ev-ico {
  background: var(--danger-soft);
  color: var(--danger);
}

.ev-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.path {
  overflow-wrap: anywhere;
}

.small {
  font-size: 12px;
}

.tag {
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 11px;
  font-weight: 600;
}

.ev-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  font-size: 13px;
  white-space: nowrap;
}
</style>
