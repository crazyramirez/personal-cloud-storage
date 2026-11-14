<script setup lang="ts">
/** Diálogo de texto (nuevo nombre, nueva carpeta…). Preselecciona el nombre sin la extensión. */
const props = defineProps<{ options: PromptOptions }>();
const emit = defineEmits<{ done: [value: string | null] }>();

const dialog = ref<HTMLDialogElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const value = ref(props.options.value ?? '');
const error = liveText();
const saving = ref(false);

onMounted(async () => {
  dialog.value?.showModal();
  await nextTick();
  const el = input.value;
  if (el === null) return;
  el.focus();
  el.setSelectionRange(0, props.options.selectLength ?? el.value.length);
});

function cancel(): void {
  if (saving.value) return;
  dialog.value?.close();
  emit('done', null);
}

async function submit(): Promise<void> {
  const text = value.value.trim() === '' ? '' : value.value;
  if (text === '' || saving.value) return;
  const local = props.options.validate?.(text) ?? null;
  if (local !== null) {
    error.value = local;
    return;
  }
  if (props.options.submit !== undefined) {
    saving.value = true;
    error.value = '';
    try {
      await props.options.submit(text);
    } catch (failure) {
      error.value = errorText(failure, 'ui.couldNotComplete');
      saving.value = false;
      await nextTick();
      input.value?.focus();
      return;
    }
    saving.value = false;
  }
  dialog.value?.close();
  emit('done', text);
}
</script>

<template>
  <dialog ref="dialog" class="dlg" aria-labelledby="prompt-title" @cancel.prevent="cancel">
    <form class="body" @submit.prevent="submit">
      <h2 id="prompt-title">{{ options.title }}</h2>
      <div class="field">
        <label for="prompt-input">{{ options.label }}</label>
        <input
          id="prompt-input"
          ref="input"
          v-model="value"
          class="input"
          :type="options.inputType ?? 'text'"
          :maxlength="options.inputType === 'password' ? 1024 : 255"
          :autocomplete="options.inputType === 'password' ? 'new-password' : 'off'"
          autocapitalize="off"
          spellcheck="false"
          enterkeyhint="done"
          :aria-invalid="error !== '' ? 'true' : undefined"
          aria-describedby="prompt-help"
          @input="error = ''"
        >
        <span id="prompt-help" class="muted help">{{ options.help ?? t('ui.forbiddenChars') }}</span>
      </div>
      <p v-if="error" role="alert" class="notice notice-danger">{{ error }}</p>
      <div class="actions">
        <button type="button" class="btn" :disabled="saving" @click="cancel">{{ t('common.cancel') }}</button>
        <button type="submit" class="btn btn-primary" :disabled="saving || value.trim() === ''">{{ saving ? t('ui.saving') : options.confirm }}</button>
      </div>
    </form>
  </dialog>
</template>
