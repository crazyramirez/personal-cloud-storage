<script setup lang="ts">
/**
 * Crear un enlace para compartir (ADR-0018): caducidad, límite de descargas y contraseña
 * opcional. Después enseña el enlace (una sola vez) y el estado del acceso desde Internet.
 */
import type { GatewayView, ShareCreateResponse } from '@pcloud/contracts';

const props = defineProps<{ options: ShareOptions }>();
const emit = defineEmits<{ done: [value: null] }>();

const dialog = ref<HTMLDialogElement | null>(null);
const linkInput = ref<HTMLInputElement | null>(null);
const days = ref<1 | 7 | 30>(7);
const max = ref<0 | 1 | 3 | 10>(0);
const protect = ref(false);
const password = ref('');
const busy = ref(false);
const error = liveText();
const created = ref<ShareCreateResponse | null>(null);
const gateway = ref<GatewayView | null>(null);
const checking = ref(false);
let poll: ReturnType<typeof setInterval> | null = null;

onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => stopPoll());

const link = computed(() => (created.value !== null && gateway.value?.url ? `${gateway.value.url}/s/${created.value.token}` : null));
const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

function stopPoll(): void {
  if (poll !== null) clearInterval(poll);
  poll = null;
}

async function refreshGateway(): Promise<void> {
  try {
    gateway.value = await api<GatewayView>('/shares/gateway', { handle401: false });
    if (gateway.value.state === 'on') {
      stopPoll();
      await nextTick();
      linkInput.value?.select();
    }
  } catch {
    // Se reintenta en el siguiente ciclo.
  }
}

async function create(): Promise<void> {
  if (busy.value) return;
  if (protect.value && password.value.length < 4) {
    error.value = () => t('shares.passwordShort');
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    created.value = await api<ShareCreateResponse>('/shares', {
      method: 'POST',
      body: {
        path: props.options.path,
        expiresInDays: days.value,
        ...(protect.value ? { password: password.value } : {}),
        ...(max.value === 0 || props.options.kind !== 'file' ? {} : { maxDownloads: max.value }),
      },
    });
    gateway.value = created.value.gateway;
    if (gateway.value.state !== 'on') poll = setInterval(() => void refreshGateway(), 2000);
    else {
      await nextTick();
      linkInput.value?.select();
    }
  } catch (failure) {
    error.value = errorText(failure instanceof ApiError ? failure : null, 'shares.createFailed');
  } finally {
    busy.value = false;
  }
}

async function check(): Promise<void> {
  checking.value = true;
  try {
    gateway.value = await api<GatewayView>('/shares/gateway/check', { method: 'POST', timeoutMs: 70_000 });
  } catch {
    // El estado se sigue consultando.
  } finally {
    checking.value = false;
  }
}

async function copy(): Promise<void> {
  if (link.value === null) return;
  try {
    await navigator.clipboard.writeText(link.value);
    toast(t('shares.copied'), { tone: 'ok' });
  } catch {
    linkInput.value?.select();
  }
}

async function send(): Promise<void> {
  if (link.value === null) return;
  await navigator.share({ title: props.options.name, text: t('shares.shareText', { name: props.options.name }), url: link.value }).catch(() => undefined);
}

function close(): void {
  if (busy.value) return;
  stopPoll();
  dialog.value?.close();
  emit('done', null);
}

const summary = computed(() => {
  const share = created.value?.share;
  if (share === undefined) return '';
  const parts = [t('shares.summaryUntil', { date: formatDate(share.expiresAt) })];
  if (share.maxDownloads !== null) parts.push(t('shares.summaryMax', { n: share.maxDownloads }));
  if (share.hasPassword) parts.push(t('shares.summaryPassword'));
  return parts.join(' · ');
});
</script>

<template>
  <dialog ref="dialog" class="dlg share-dlg" aria-labelledby="share-title" @cancel.prevent="close">
    <form v-if="created === null" class="body" @submit.prevent="create">
      <h2 id="share-title">{{ t('shares.titleFile', { name: options.name }) }}</h2>
      <p class="muted">{{ options.kind === 'dir' ? t('shares.introDir') : t('shares.intro') }}</p>

      <fieldset class="seg-field">
        <legend>{{ t('shares.expiry') }}</legend>
        <div class="seg" role="radiogroup">
          <label v-for="n in [1, 7, 30] as const" :key="n" :class="{ on: days === n }">
            <input v-model="days" type="radio" name="share-days" :value="n">{{ t('shares.days', { n }) }}
          </label>
        </div>
      </fieldset>

      <fieldset v-if="options.kind === 'file'" class="seg-field">
        <legend>{{ t('shares.limit') }}</legend>
        <div class="seg" role="radiogroup">
          <label v-for="n in [0, 1, 3, 10] as const" :key="n" :class="{ on: max === n }">
            <input v-model="max" type="radio" name="share-max" :value="n">{{ n === 0 ? t('shares.unlimited') : n }}
          </label>
        </div>
      </fieldset>

      <label class="check"><input v-model="protect" type="checkbox"><span>{{ t('shares.protect') }}</span></label>
      <div v-if="protect" class="field">
        <label for="share-password">{{ t('shares.passwordLabel') }}</label>
        <input id="share-password" v-model="password" class="input" type="text" minlength="4" maxlength="128" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="share-password-help">
        <span id="share-password-help" class="muted help">{{ t('shares.passwordHelp') }}</span>
      </div>

      <p v-if="error" role="alert" class="notice notice-danger">{{ error }}</p>
      <div class="actions">
        <button type="button" class="btn" :disabled="busy" @click="close">{{ t('common.cancel') }}</button>
        <button type="submit" class="btn btn-primary" :disabled="busy"><AppIcon name="link" />{{ busy ? t('shares.creating') : t('shares.create') }}</button>
      </div>
    </form>

    <div v-else class="body">
      <h2 id="share-title">{{ link ? t('shares.readyTitle') : t('shares.openingTitle') }}</h2>

      <template v-if="link">
        <div class="linkbox">
          <input ref="linkInput" class="input" :value="link" readonly :aria-label="t('shares.copy')" @focus="($event.target as HTMLInputElement).select()">
        </div>
        <div class="link-actions">
          <button type="button" class="btn btn-primary" @click="copy"><AppIcon name="copy" />{{ t('shares.copy') }}</button>
          <button v-if="canShare" type="button" class="btn" @click="send"><AppIcon name="external" />{{ t('shares.share') }}</button>
        </div>
        <p class="muted small">{{ summary }}</p>
        <p class="notice notice-warn small">{{ t('shares.onceWarning') }}</p>
      </template>

      <template v-else-if="gateway">
        <p v-if="gateway.state === 'starting' || gateway.state === 'off'" class="opening"><span class="spin" aria-hidden="true" />{{ t('shares.opening') }}</p>
        <div v-else class="notice" :class="gateway.state === 'error' ? 'notice-danger' : 'notice-info'" role="status">
          <p>{{ gatewayText(gateway) }}</p>
          <div class="gw-actions">
            <a v-if="(gateway.state === 'needs_funnel' || gateway.state === 'needs_login') && gateway.enableUrl" class="btn btn-primary" :href="gateway.enableUrl" target="_blank" rel="noopener noreferrer"><AppIcon name="external" />{{ gateway.state === 'needs_login' ? t('shares.gwConnect') : t('shares.gwAllowFunnel') }}</a>
            <button type="button" class="btn" :disabled="checking" @click="check"><span v-if="checking" class="spin" aria-hidden="true" /><AppIcon v-else name="refresh" />{{ checking ? t('shares.gwChecking') : t('shares.gwCheck') }}</button>
          </div>
        </div>
        <p class="muted small">{{ summary }}</p>
      </template>

      <div class="actions">
        <button type="button" class="btn" :class="{ 'btn-primary': link }" @click="close">{{ t('shares.done') }}</button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.share-dlg {
  width: min(520px, calc(100vw - 24px));
}

fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}

legend {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.seg {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 10px;
  background: var(--surface-2, var(--bg));
  border: 1px solid var(--border);
}

.seg label {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 36px;
  padding: 0 8px;
  border-radius: 7px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.seg label.on {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
}

.seg label:has(input:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.seg input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.check {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
}

.check input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent-btn);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field label {
  font-size: 13px;
  font-weight: 600;
}

.linkbox .input {
  width: 100%;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}

.link-actions,
.gw-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.gw-actions {
  margin-top: 10px;
}

.small {
  font-size: 12.5px;
}

.opening {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--muted);
}

.spin {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
