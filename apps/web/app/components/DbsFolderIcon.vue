<script setup lang="ts">
/**
 * Icono de la carpeta de DEV Backup Studio (ADR-0023): la silueta de carpeta con el degradado de
 * la app (violeta → cian) y sus flechas de sincronización en blanco. Se reconoce a la vez como
 * carpeta y como «las copias de DEV Backup Studio».
 */
withDefaults(defineProps<{ size?: number }>(), { size: 24 });
const id = useId();
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" class="dbs-folder" aria-hidden="true">
    <defs>
      <linearGradient :id="`dbs-${id}`" x1="2" y1="3" x2="22" y2="21" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#7b6cff" />
        <stop offset="1" stop-color="#33d1ee" />
      </linearGradient>
    </defs>
    <!-- Pestaña y cuerpo de la carpeta. -->
    <path :fill="`url(#dbs-${id})`" d="M2.5 6.6A2.6 2.6 0 0 1 5.1 4h3.7c.6 0 1.2.25 1.6.7l1.3 1.4h7.2a2.6 2.6 0 0 1 2.6 2.6v9.7a2.6 2.6 0 0 1-2.6 2.6H5.1a2.6 2.6 0 0 1-2.6-2.6z" />
    <path fill="#fff" opacity="0.16" d="M2.5 9.2h19v-.5a2.6 2.6 0 0 0-2.6-2.6H11.6l-1.3-1.4a2.2 2.2 0 0 0-1.6-.7H5.1a2.6 2.6 0 0 0-2.6 2.6z" />
    <!-- Flechas de sincronización (como el icono de la app). -->
    <g fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8.6 12.4a3.6 3.6 0 0 1 6.5-.8" />
      <path d="M8.5 10.3v2.1h2.1" />
      <path d="M15.4 14.6a3.6 3.6 0 0 1-6.5.8" />
      <path d="M15.5 16.7v-2.1h-2.1" />
    </g>
  </svg>
</template>

<style scoped>
.dbs-folder {
  flex: none;
  display: block;
}
</style>
