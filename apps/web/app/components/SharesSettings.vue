<script setup lang="ts">
/** Ajustes → Enlaces compartidos (ADR-0018). Solo propietario. */
import type { GatewayView, ShareListResponse, ShareView } from '@pcloud/contracts';

const shares = ref<ShareView[]>([]);
const gateway = ref<GatewayView | null>(null);
const loaded = ref(false);
const failure = liveText();
const checking = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  try {
    const data = await api<ShareListResponse>('/shares', { handle401: false });
    shares.value = [...data.shares];
    gateway.value = data.gateway;
    failure.value = '';
  } catch (error) {
    failure.value = errorText(error instanceof ApiError ? error : null, 'shares.loadFailed');
  } finally {
    loaded.value = true;
  }
}

onMounted(() => {
  void load();
  if (useRoute().hash === '#enlaces') void nextTick(() => document.getElementById('enlaces')?.scrollIntoView({ block: 'start' }));
  // Las caducidades y el estado del acceso cambian solos: se refresca cada 15 s con la pestaña visible.
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') void load();
  }, 15_000);
});
onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer);
});

async function check(): Promise<void> {
  checking.value = true;
  try {
    gateway.value = await api<GatewayView>('/shares/gateway/check', { method: 'POST', timeoutMs: 70_000 });
  } catch {
    // Se verá en la próxima carga.
  } finally {
    checking.value = false;
  }
}

async function revoke(share: ShareView): Promise<void> {
  const ok = await confirmDialog({ title: t('shares.revokeTitle'), message: t('shares.revokeMessage', { name: share.name }), confirm: t('shares.revokeConfirm'), danger: true });
  if (!ok) return;
  try {
    await api(`/shares/${share.id}`, { method: 'DELETE' });
    toast(t('shares.revoked'), { tone: 'ok' });
  } catch (error) {
    toast(error instanceof ApiError ? serverText(error.message) : t('ui.couldNotComplete'), { tone: 'danger' });
  }
  await load();
}

async function remove(share: ShareView): Promise<void> {
  try {
    await api(`/shares/${share.id}`, { method: 'DELETE' });
  } catch (error) {
    toast(error instanceof ApiError ? serverText(error.message) : t('ui.couldNotComplete'), { tone: 'danger' });
  }
  await load();
}

const STATE_LABEL = { active: 'shares.stateActive', expired: 'shares.stateExpired', exhausted: 'shares.stateExhausted', revoked: 'shares.stateRevoked' } as const;
const STATE_CHIP = { active: 'chip-ok', expired: '', exhausted: '', revoked: '' } as const;

const gatewayTone = computed(() => {
  const state = gateway.value?.state ?? 'off';
  if (state === 'on') return 'ok';
  if (state === 'off' || state === 'starting') return 'idle';
  return state === 'error' ? 'danger' : 'warn';
});

function downloadsText(share: ShareView): string {
  return t('shares.downloads', { n: share.downloads, max: share.maxDownloads === null ? '' : share.maxDownloads });
}
</script>

<template>
  <section id="enlaces" class="card sec" aria-labelledby="s-shares">
    <header>
      <AppIcon name="globe" />
      <h2 id="s-shares">{{ t('shares.settingsTitle') }}</h2>
    </header>
    <p class="muted">{{ t('shares.settingsIntro') }}</p>

    <div v-if="gateway" class="gw" :class="`gw-${gatewayTone}`" role="status">
      <span class="gw-dot" aria-hidden="true" />
      <div class="gw-text">
        <strong>{{ t('shares.internet') }}</strong>
        <span>{{ gatewayText(gateway) }}</span>
        <div v-if="gatewayTone === 'warn' || gatewayTone === 'danger'" class="gw-actions">
          <a v-if="(gateway.state === 'needs_funnel' || gateway.state === 'needs_login') && gateway.enableUrl" class="btn btn-primary" :href="gateway.enableUrl" target="_blank" rel="noopener noreferrer"><AppIcon name="external" />{{ gateway.state === 'needs_login' ? t('shares.gwConnect') : t('shares.gwAllowFunnel') }}</a>
          <button type="button" class="btn" :disabled="checking" @click="check"><AppIcon name="refresh" />{{ checking ? t('shares.gwChecking') : t('shares.gwCheck') }}</button>
        </div>
      </div>
    </div>

    <p v-if="failure" role="alert" class="notice notice-danger">{{ failure }}</p>
    <p v-else-if="loaded && shares.length === 0" class="muted empty">{{ t('shares.empty') }}</p>

    <ul v-if="shares.length > 0" class="list">
      <li v-for="share in shares" :key="share.id" :class="{ dim: share.state !== 'active' }">
        <span class="ico"><AppIcon :name="share.kind === 'dir' ? 'folder' : fileKind(share.name, 'file').icon" :size="20" /></span>
        <div class="main">
          <div class="top">
            <strong class="name">{{ share.name }}</strong>
            <span class="chip" :class="STATE_CHIP[share.state]">{{ t(STATE_LABEL[share.state]) }}</span>
            <span v-if="share.hasPassword" class="lock" :title="t('shares.withPassword')"><AppIcon name="lock" :size="13" /><span class="sr-only">{{ t('shares.withPassword') }}</span></span>
          </div>
          <span class="path muted">{{ share.path }}</span>
          <span class="meta muted">
            <span v-if="share.state === 'active' || share.state === 'expired'">{{ t(share.state === 'active' ? 'shares.expires' : 'shares.expired', { when: formatRelative(share.expiresAt) }) }}</span>
            <span>{{ downloadsText(share) }}</span>
            <span>{{ share.lastAccessAt ? t('shares.lastAccess', { when: formatRelative(share.lastAccessAt) }) : t('shares.neverOpened') }}</span>
          </span>
        </div>
        <button v-if="share.state === 'active'" type="button" class="btn btn-danger" @click="revoke(share)">{{ t('shares.revoke') }}</button>
        <button v-else type="button" class="btn icon-btn" :title="t('shares.remove')" :aria-label="t('shares.remove')" @click="remove(share)"><AppIcon name="close" /></button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.sec {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  scroll-margin-top: 80px;
}

.sec header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sec h2 {
  font-size: 17px;
  font-weight: 650;
}

.gw {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--surface-2);
}

.gw-dot {
  flex: none;
  width: 10px;
  height: 10px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--muted);
}

.gw-ok .gw-dot {
  background: var(--ok);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 18%, transparent);
}

.gw-warn .gw-dot {
  background: var(--warn);
}

.gw-danger .gw-dot {
  background: var(--danger);
}

.gw-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13.5px;
  min-width: 0;
}

.gw-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.empty {
  font-size: 14px;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.list li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}

.list li.dim .ico,
.list li.dim .name {
  opacity: 0.6;
}

.ico {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.name {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.lock {
  display: inline-flex;
  color: var(--muted);
}

.path {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  font-size: 12px;
}

.icon-btn {
  width: 36px;
  min-height: 36px;
  padding: 0;
  justify-content: center;
}
</style>
