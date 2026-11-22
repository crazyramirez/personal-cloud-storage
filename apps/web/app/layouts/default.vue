<script setup lang="ts">
const session = useSession();
const storage = useStorage();
const { theme, toggle } = useTheme();
const { pending, totals, panelOpen } = useTransfers();
const route = useRoute();
/** Acceso fuera de casa por Tailscale. */
const remote = viaTailscale();

/** Alto real de la cabecera fija (cambia si sus botones se reparten en dos líneas). Lo usan
 *  los elementos «sticky» de las páginas para quedarse justo debajo y no tapados por ella. */
const top = ref<HTMLElement | null>(null);
const topHeight = ref(0);
let topObserver: ResizeObserver | null = null;

onMounted(() => {
  storage.start();
  if (top.value) {
    topObserver = new ResizeObserver(() => {
      topHeight.value = top.value?.offsetHeight ?? 0;
    });
    topObserver.observe(top.value);
  }
});
onBeforeUnmount(() => {
  storage.stop();
  topObserver?.disconnect();
});

const NAV = computed<Array<{ to: string; label: string; icon: IconName; mobile: boolean }>>(() => [
  { to: '/panel', label: t('nav.dashboard'), icon: 'gauge', mobile: true },
  { to: '/archivos', label: t('nav.files'), icon: 'folder', mobile: true },
  { to: '/papelera', label: t('nav.trash'), icon: 'trash', mobile: true },
  { to: '/actividad', label: t('nav.activity'), icon: 'clock', mobile: false },
  { to: '/ajustes', label: t('nav.settings'), icon: 'sliders', mobile: true },
]);
const MOBILE_NAV = computed(() => NAV.value.filter((item) => item.mobile));

function isActive(to: string): boolean {
  return route.path === to || route.path.startsWith(`${to}/`);
}

async function signOut(): Promise<void> {
  await session.logout();
  await navigateTo('/entrar');
}
const appVersion = useAppVersion();
</script>

<template>
  <div class="shell" :style="{ '--top-h': `${topHeight}px` }">
    <nav :aria-label="t('nav.mainNav')" class="side">
      <div class="brand">
        <span class="logo"><AppIcon name="cloud" :size="20" :stroke="1.9" /></span>
        <div class="names">
          <strong>Personal Cloud</strong>
          <span class="muted">{{ remote ? t('nav.remote') : t('nav.local') }}</span>
        </div>
      </div>

      <ul class="menu">
        <li v-for="item in NAV" :key="item.to">
          <NuxtLink :to="item.to" class="link" :class="{ current: isActive(item.to) }" :aria-current="isActive(item.to) ? 'page' : undefined">
            <AppIcon :name="item.icon" />{{ item.label }}
          </NuxtLink>
        </li>
      </ul>

      <DiskWidget />
      <p v-if="appVersion?.version" class="version muted" :title="appVersion.release ?? undefined">{{ t('nav.version', { v: appVersion.version }) }}</p>
    </nav>

    <div class="main">
      <header ref="top" class="top">
        <StatusPill />
        <div class="tools">
          <BackupIndicator />
          <button
            type="button"
            class="btn btn-icon uploads"
            :class="{ open: panelOpen }"
            :aria-label="pending.length > 0 ? t('transfers.openPanelBusy', { n: pending.length }) : t('transfers.openPanel')"
            :title="t('transfers.openPanel')"
            :aria-expanded="panelOpen"
            aria-haspopup="dialog"
            @click="panelOpen = !panelOpen"
          >
            <ProgressRing v-if="totals.uploading > 0" class="ring" :value="totals.percent / 100" :size="38" :stroke="2.5" />
            <AppIcon name="upload" />
            <span v-if="pending.length > 0" class="badge" :class="{ danger: totals.failed > 0 }">{{ pending.length }}</span>
          </button>
          <button type="button" class="btn btn-icon" :aria-label="theme === 'dark' ? t('nav.lightTheme') : t('nav.darkTheme')" @click="toggle">
            <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" />
          </button>
          <span v-if="session.user.value" class="who"><span class="avatar" aria-hidden="true">{{ session.user.value.username.charAt(0).toUpperCase() }}</span>{{ session.user.value.username }}</span>
          <button type="button" class="btn" @click="signOut"><AppIcon name="logout" />{{ t('nav.signOut') }}</button>
        </div>
      </header>
      <main class="content">
        <slot />
      </main>
    </div>

    <nav :aria-label="t('nav.tabNav')" class="tabbar">
      <NuxtLink v-for="item in MOBILE_NAV" :key="item.to" :to="item.to" class="tab" :class="{ current: isActive(item.to) }" :aria-current="isActive(item.to) ? 'page' : undefined">
        <AppIcon :name="item.icon" :size="22" />
        <span>{{ item.label }}</span>
      </NuxtLink>
    </nav>
    <TransfersPanel />
    <UiHost />
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-wrap: wrap;
}

.side {
  flex: 1 1 236px;
  max-width: 100%;
  padding: calc(20px + env(safe-area-inset-top)) 14px 20px calc(14px + env(safe-area-inset-left));
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 24px;
  /* Fija al hacer scroll: el menú sigue a la vista aunque la página sea larga. */
  position: sticky;
  top: 0;
  align-self: flex-start;
  height: 100vh;
  height: 100dvh;
  overflow-y: auto;
}

.version {
  margin-top: -14px;
  padding: 0 10px;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px;
}

.logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: var(--accent-btn);
  color: #ffffff;
}

.names {
  display: flex;
  flex-direction: column;
}

.names strong {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.names span {
  font-size: 12px;
}

.menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.link {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 0 12px;
  border-radius: 10px;
  color: var(--text);
  font-weight: 500;
  text-decoration: none;
}

a.link:hover {
  background: var(--surface-2);
}

.link.current {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.link.soon {
  color: var(--muted);
}


.main {
  flex: 999 1 560px;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  /* Fija arriba al hacer scroll, en escritorio y en móvil. */
  position: sticky;
  top: 0;
  z-index: 20;
}

.tools {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.uploads {
  position: relative;
}

.uploads.open {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.uploads .ring {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--accent-btn);
  color: #ffffff;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
}

.badge.danger {
  background: #b42318;
}

.who {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}

.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
}

.content {
  flex: 1;
  padding: 20px 24px 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.tabbar {
  display: none;
}

/* Móvil: barra inferior de pestañas, como una app nativa; la barra lateral se oculta. */
@media (max-width: 820px) {
  .side {
    display: none;
  }

  /* Los avisos (UiHost) se apoyan justo encima de la barra de pestañas. */
  .shell {
    --toast-bottom: calc(var(--tabbar-h) + 8px);
  }

  .top {
    padding: calc(8px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right)) 8px calc(12px + env(safe-area-inset-left));
  }

  /* Solo iconos en la cabecera: el nombre de usuario y «Salir» se reducen a su icono. */
  .who,
  .tools .btn:not(.btn-icon) {
    font-size: 0;
    gap: 0;
  }

  .avatar {
    font-size: 15px;
  }

  .content {
    padding: 14px calc(12px + env(safe-area-inset-right)) calc(var(--tabbar-h) + 20px) calc(12px + env(safe-area-inset-left));
  }

  .tabbar {
    position: fixed;
    z-index: 30;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    justify-content: space-around;
    padding: 6px calc(4px + env(safe-area-inset-right)) var(--tabbar-pad-bottom) calc(4px + env(safe-area-inset-left));
    background: var(--surface);
    border-top: 1px solid var(--border);
  }

  .tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-height: 52px;
    justify-content: center;
    border-radius: 10px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 500;
    text-decoration: none;
  }

  .tab.current {
    color: var(--accent);
    font-weight: 700;
  }

}
</style>
