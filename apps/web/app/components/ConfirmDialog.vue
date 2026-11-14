<script setup lang="ts">
/** Confirmación explícita (solo para acciones que no se pueden deshacer). */
const props = defineProps<{ options: ConfirmOptions }>();
const emit = defineEmits<{ done: [value: boolean] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);

onMounted(() => {
  dialog.value?.showModal();
  // En acciones peligrosas el foco empieza en «Cancelar»: Intro no borra nada por accidente.
  if (props.options.danger === true) cancelButton.value?.focus();
});

function finish(value: boolean): void {
  dialog.value?.close();
  emit('done', value);
}
</script>

<template>
  <dialog ref="dialog" class="dlg" role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-text" @cancel.prevent="finish(false)">
    <div class="body">
      <h2 id="confirm-title">{{ options.title }}</h2>
      <p id="confirm-text" class="muted">{{ options.message }}</p>
      <div class="actions">
        <button ref="cancelButton" type="button" class="btn" @click="finish(false)">{{ t('common.cancel') }}</button>
        <button type="button" class="btn" :class="options.danger ? 'btn-danger-solid' : 'btn-primary'" @click="finish(true)">{{ options.confirm }}</button>
      </div>
    </div>
  </dialog>
</template>
