<script setup lang="ts">
useHead({ title: () => t('panel.pageTitle') });

const { status, state, readable, unreachable } = useStorage();
const { active, transfers } = useTransfers();

const label = computed(() => VOLUME_LABELS[state.value]);
const space = computed(() => status.value?.space ?? null);
const used = computed(() => (space.value === null ? 0 : space.value.totalBytes - space.value.freeBytes));
const percent = computed(() => (space.value === null || space.value.totalBytes === 0 ? 0 : Math.max(1, Math.round((used.value / space.value.totalBytes) * 100))));
const fsLabel = computed(() => {
  const type = status.value?.mount?.fsType;
  return type === 'exfat' ? 'exFAT' : type === 'ntfs3' || type === 'fuseblk' ? 'NTFS' : (type ?? '—');
});
const finished = computed(() => transfers.value.filter((item) => item.state === 'done').length);

/** Se comprueba de verdad: no se afirma «cifrada» si la página se cargó por HTTP. */
const encrypted = import.meta.client && window.location.protocol === 'https:';
/** Entrando por Tailscale (nombre *.ts.net o IP 100.64/10): fuera de casa, por VPN privada. */
const viaTailscale = import.meta.client && /\.ts\.net$|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(window.location.hostname);
const publicCert = import.meta.client && window.location.hostname.endsWith('.ts.net');

const trash = ref<{ entries: unknown[]; totalBytes: number } | null>(null);
async function loadTrash(): Promise<void> {
  try {
    trash.value = await api<{ entries: unknown[]; totalBytes: number }>('/trash');
  } catch {
    trash.value = null; // sin disco: no se muestra
  }
}
onMounted(loadTrash);
watch(readable, (now) => {
  if (now) void loadTrash();
});

/** Aviso de copia de seguridad: discreto (icono junto al título); se despliega al pulsarlo. */
const backupOpen = ref(false);
const backupRef = ref<HTMLElement | null>(null);
function closeBackup(event: Event): void {
  if (!backupOpen.value) return;
  if (event instanceof KeyboardEvent) {
    if (event.key === 'Escape') backupOpen.value = false;
    return;
  }
  if (!backupRef.value?.contains(event.target as Node)) backupOpen.value = false;
}
onMounted(() => {
  document.addEventListener('pointerdown', closeBackup);
  document.addEventListener('keydown', closeBackup);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeBackup);
  document.removeEventListener('keydown', closeBackup);
});
</script>

<template>
  <div class="page">
    <div class="heading">
      <h1>{{ t('panel.title') }}</h1>
      <span class="muted subtitle">{{ t('panel.subtitle') }}</span>
      <div ref="backupRef" class="backup-wrap">
        <button
          type="button"
          class="backup-btn"
          :aria-expanded="backupOpen"
          aria-controls="aviso-copia"
          :aria-label="t('panel.backupAria')"
          :title="t('panel.backupTitle')"
          @click="backupOpen = !backupOpen"
        >
          <AppIcon name="alert" :size="18" />
        </button>
        <Transition name="pop">
          <section v-if="backupOpen" id="aviso-copia" role="note" :aria-label="t('panel.backupNoteAria')" class="backup">
            <AppIcon name="shield" :size="20" class="warn" />
            <div class="backup-text">
              <strong>{{ t('panel.backupTitle') }}</strong>
              <span>{{ t('panel.backupBody') }}</span>
            </div>
          </section>
        </Transition>
      </div>
    </div>

    <DiskUnavailable v-if="unreachable" />

    <div v-else class="cards">
      <section aria-labelledby="t-disco" class="card block">
        <div class="title">
          <AppIcon name="drive" :size="20" class="muted" />
          <h2 id="t-disco">{{ t('panel.disk') }}</h2>
          <span class="chip" :class="`chip-${label.tone}`">{{ label.pill }}</span>
        </div>
        <template v-if="space">
          <div>
            <p class="big">{{ t('panel.free', { size: formatBytes(space.freeBytes) }) }}</p>
            <p class="muted">{{ t('panel.usedOf', { used: formatBytes(used), total: formatBytes(space.totalBytes) }) }}</p>
          </div>
          <div class="bar thick" aria-hidden="true"><span :style="{ width: `${percent}%` }" /></div>
        </template>
        <p v-else-if="!readable" class="muted">{{ status?.issues[0]?.message ? serverText(status.issues[0].message) : t('panel.checkingDisk') }}</p>
        <dl class="kv">
          <dt>{{ t('panel.format') }}</dt>
          <dd>{{ fsLabel }}</dd>
          <dt>{{ t('panel.device') }}</dt>
          <dd class="mono">{{ status?.mount?.source ?? '—' }}</dd>
          <template v-if="space">
            <dt>{{ t('panel.reserve') }}</dt>
            <dd>{{ t('panel.reserveHint', { size: formatBytes(space.reservedBytes) }) }}</dd>
          </template>
          <dt>{{ t('panel.checked') }}</dt>
          <dd>{{ status ? formatDate(status.checkedAt) : '—' }}</dd>
        </dl>
      </section>

      <section aria-labelledby="t-transf" class="card block">
        <div class="title">
          <AppIcon name="transfers" :size="20" class="muted" />
          <h2 id="t-transf">{{ t('panel.transfers') }}</h2>
        </div>
        <p class="big">{{ t('panel.activeCount', { n: active.length }) }}</p>
        <p class="muted">{{ t('panel.finishedCount', { n: finished }) }}</p>
        <NuxtLink to="/transferencias" class="more">{{ t('panel.viewTransfers') }}<AppIcon name="chevron" :size="16" :stroke="2" /></NuxtLink>
      </section>

      <section aria-labelledby="t-acceso" class="card block">
        <div class="title">
          <AppIcon name="lock" :size="20" class="muted" />
          <h2 id="t-acceso">{{ t('panel.access') }}</h2>
        </div>
        <dl class="kv">
          <dt>{{ t('panel.scope') }}</dt>
          <dd>{{ t('panel.scopeValue') }}<template v-if="viaTailscale">{{ t('panel.viaTailscale') }}</template></dd>
          <dt>{{ t('panel.connection') }}</dt>
          <dd v-if="encrypted">{{ publicCert ? t('panel.encryptedTailscale') : t('panel.encryptedOwn') }}</dd>
          <dd v-else class="warn-text">{{ t('panel.unencrypted') }}</dd>
          <dt>{{ t('panel.trash') }}</dt>
          <dd>
            <NuxtLink to="/papelera">{{ trash === null ? t('panel.viewTrash') : trash.entries.length === 0 ? t('panel.trashEmpty') : `${t('panel.items', { n: trash.entries.length })} · ${formatBytes(trash.totalBytes)}` }}</NuxtLink>
          </dd>
        </dl>
      </section>
    </div>

    <RecentGrid v-if="!unreachable && readable" />
  </div>
</template>

<style scoped>
.warn-text {
  color: var(--warn);
  font-weight: 600;
}
.page {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}

h1 {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

h2 {
  font-size: 15px;
  font-weight: 600;
}

.heading {
  position: relative;
}

/* La burbuja se ancla al encabezado (no al icono): nunca se sale de la pantalla en móvil. */
.backup-wrap {
  align-self: center;
}

.backup-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid transparent;
  background: none;
  color: var(--warn);
  transition: background 0.15s ease, border-color 0.15s ease;
}

.backup-btn:hover,
.backup-btn[aria-expanded='true'] {
  background: var(--warn-soft);
  border-color: var(--warn-border);
}

.backup-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.backup {
  position: absolute;
  z-index: 30;
  top: calc(100% + 8px);
  left: 0;
  width: min(420px, 100%);
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid var(--warn-border);
  background: var(--surface);
  box-shadow: var(--shadow);
}

.backup::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--warn-soft);
  pointer-events: none;
}

.backup > * {
  position: relative;
}

.backup-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  line-height: 1.45;
}

.backup-text strong {
  font-size: 14px;
  font-weight: 600;
  color: var(--warn);
}

.pop-enter-active,
.pop-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (prefers-reduced-motion: reduce) {
  .pop-enter-active,
  .pop-leave-active {
    transition: none;
  }
}

.warn {
  color: var(--warn);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.title .chip {
  margin-left: auto;
}

.big {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.bar.thick {
  height: 8px;
  border-radius: 4px;
}

.more {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  color: var(--accent);
  font-weight: 600;
  text-decoration: none;
}

@media (max-width: 640px) {
  .heading .subtitle {
    order: 3;
    flex-basis: 100%;
  }
}
</style>
