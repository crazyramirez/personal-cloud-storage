<script setup lang="ts">
useHead({ title: () => t('favorites.pageTitle') });
</script>

<template>
  <div class="page">
    <div class="heading">
      <h1>{{ t('favorites.title') }}</h1>
      <span class="muted subtitle">{{ t('favorites.subtitle') }}</span>
    </div>
    <FavoritesGrid mode="page" />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 10px;
}

h1 {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

@media (max-width: 640px) {
  .heading .subtitle {
    flex-basis: 100%;
  }
}
</style>
