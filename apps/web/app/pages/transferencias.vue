<script setup lang="ts">
/** Ruta antigua: las subidas viven ahora en el panel de la cabecera. Se conserva para enlaces guardados. */
const { openPanel } = useTransfers();
onMounted(() => {
  openPanel();
  void navigateTo('/archivos', { replace: true });
});
</script>

<template>
  <div />
</template>
