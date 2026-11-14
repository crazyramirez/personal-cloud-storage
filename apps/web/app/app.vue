<script setup lang="ts">
// Idioma del documento (lectores de pantalla, guiones, traductor del navegador): sigue al de la interfaz.
useHead({ htmlAttrs: { lang: () => locale.value } });
</script>

<template>
  <div class="statusbar" aria-hidden="true" />
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
