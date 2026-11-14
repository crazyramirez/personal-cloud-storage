<script setup lang="ts">
const { theme, toggle } = useTheme();
</script>

<template>
  <div class="page">
    <header class="top">
      <span class="logo"><AppIcon name="cloud" :size="22" :stroke="1.9" /></span>
      <div class="brand">
        <strong>Personal Cloud</strong>
        <span class="muted">{{ t('nav.tagline') }}</span>
      </div>
      <button type="button" class="btn btn-icon" :aria-label="theme === 'dark' ? t('nav.lightTheme') : t('nav.darkTheme')" @click="toggle">
        <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" />
      </button>
    </header>
    <main class="content">
      <slot />
    </main>
    <UiHost />
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  min-height: 100dvh;
  padding: calc(32px + env(safe-area-inset-top)) 20px calc(48px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
}

.top,
.content {
  width: 100%;
  max-width: 480px;
}

.top {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--accent-btn);
  color: #ffffff;
}

.brand {
  display: flex;
  flex-direction: column;
  margin-right: auto;
}

.brand strong {
  font-size: 16px;
  font-weight: 700;
}

.brand span {
  font-size: 12px;
}
</style>
