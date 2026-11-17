<script setup lang="ts">
/** Elegir carpeta de destino (mover a… / copiar a…). Navega solo por carpetas. */
import type { FsEntry, FsListResponse } from '@pcloud/contracts';

const props = defineProps<{ options: PickFolderOptions }>();
const emit = defineEmits<{ done: [value: string | null] }>();

const dialog = ref<HTMLDialogElement | null>(null);
const current = ref(props.options.start);
const folders = ref<FsEntry[]>([]);
const loading = ref(false);
const error = liveText();

const segments = computed(() => current.value.split('/').filter((part) => part !== ''));
const forbidden = computed(() => {
  const here = current.value.toUpperCase();
  return (props.options.forbidden ?? []).some((path) => here === path.toUpperCase() || here.startsWith(`${path.toUpperCase()}/`));
});

function join(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

let requestId = 0;

async function load(): Promise<void> {
  const current_ = ++requestId;
  loading.value = true;
  error.value = '';
  try {
    const all: FsEntry[] = [];
    let cursor: string | null = null;
    do {
      const page: FsListResponse = await api<FsListResponse>('/fs/list', { query: { path: current.value, limit: 1000, cursor: cursor ?? undefined } });
      all.push(...page.entries.filter((entry) => entry.type === 'dir'));
      cursor = page.nextCursor;
    } while (cursor !== null && all.length < 5000);
    if (current_ !== requestId) return;
    folders.value = all;
  } catch (failure) {
    if (current_ !== requestId) return;
    folders.value = [];
    error.value = errorText(failure instanceof ApiError ? failure : null, 'ui.folderLoadFailed');
  } finally {
    if (current_ === requestId) loading.value = false;
  }
}

function go(path: string): void {
  current.value = path;
}

watch(current, load, { immediate: true });
onMounted(() => dialog.value?.showModal());

const creating = ref(false);
const newName = ref('');

async function createFolder(): Promise<void> {
  if (newName.value.trim() === '') return;
  error.value = '';
  try {
    const created = await api<{ path: string }>('/fs/folders', { method: 'POST', body: { path: current.value, name: newName.value } });
    creating.value = false;
    newName.value = '';
    current.value = created.path;
  } catch (failure) {
    error.value = errorText(failure instanceof ApiError ? failure : null, 'ui.folderCreateFailed');
  }
}

function finish(value: string | null): void {
  dialog.value?.close();
  emit('done', value);
}
</script>

<template>
  <dialog ref="dialog" class="dlg wide" aria-labelledby="picker-title" @cancel.prevent="finish(null)">
    <div class="body">
      <h2 id="picker-title">{{ options.title }}</h2>
      <nav class="trail" :aria-label="t('ui.currentFolder')">
        <button type="button" class="crumb" :class="{ here: segments.length === 0 }" @click="go('/')"><AppIcon name="home" :size="15" />{{ t('common.files') }}</button>
        <template v-for="(name, index) in segments" :key="index">
          <AppIcon name="chevron" :size="13" class="muted" />
          <button type="button" class="crumb" :class="{ here: index === segments.length - 1 }" @click="go(`/${segments.slice(0, index + 1).join('/')}`)">{{ name }}</button>
        </template>
      </nav>
      <div class="list" :aria-busy="loading">
        <p v-if="loading" class="muted pad">{{ t('common.loading') }}</p>
        <p v-else-if="error" class="notice notice-danger">{{ error }}</p>
        <p v-else-if="folders.length === 0" class="muted pad">{{ t('ui.noSubfolders') }}</p>
        <ul v-else>
          <li v-for="folder in folders" :key="folder.name">
            <button type="button" class="row" @click="go(join(current, folder.name))">
              <DbsFolderIcon v-if="current === '/' && folder.name.toLowerCase() === BACKUP_STUDIO_FOLDER.toLowerCase()" :size="20" />
              <AppIcon v-else name="folder" :size="20" class="ico-folder" />
              <span class="name">{{ folder.name }}</span>
              <AppIcon name="chevron" :size="15" class="muted" />
            </button>
          </li>
        </ul>
      </div>
      <form v-if="creating" class="create" @submit.prevent="createFolder">
        <input v-model="newName" class="input" type="text" maxlength="255" :placeholder="t('ui.newFolderName')" :aria-label="t('ui.newFolderName')" autofocus>
        <button type="submit" class="btn btn-primary" :disabled="newName.trim() === ''">{{ t('ui.create') }}</button>
        <button type="button" class="btn" @click="creating = false">{{ t('common.cancel') }}</button>
      </form>
      <p v-if="forbidden" class="notice notice-warn">{{ t('ui.forbiddenFolder') }}</p>
      <div class="actions">
        <button type="button" class="btn left" :disabled="creating" @click="creating = true"><AppIcon name="folder-plus" />{{ t('ui.newFolder') }}</button>
        <button type="button" class="btn" @click="finish(null)">{{ t('common.cancel') }}</button>
        <button type="button" class="btn btn-primary" :disabled="forbidden || loading" @click="finish(current)">{{ options.confirm }}</button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.trail {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 13px;
}

.crumb {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  background: none;
  padding: 4px 6px;
  border-radius: 6px;
  color: var(--accent);
  font-weight: 500;
  cursor: pointer;
}

.crumb.here {
  color: var(--text);
  font-weight: 600;
}

.list {
  height: min(320px, 50vh);
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 4px;
}

.pad {
  padding: 12px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 42px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  text-align: left;
  cursor: pointer;
}

.row:hover {
  background: var(--surface-2);
}

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.left {
  margin-right: auto;
}

.create {
  display: flex;
  gap: 8px;
}

.create .input {
  flex: 1;
}
</style>
