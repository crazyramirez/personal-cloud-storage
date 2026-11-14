<script setup lang="ts">
const props = withDefaults(defineProps<{ name: IconName; size?: number; stroke?: number }>(), { size: 18, stroke: 1.8 });
// Contenido estático definido en utils/icons.ts: nunca procede de datos del usuario.
const markup = computed(() => ICONS[props.name]);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="icon"
    v-html="markup"
  />
</template>

<style scoped>
.icon {
  flex: none;
}
</style>
