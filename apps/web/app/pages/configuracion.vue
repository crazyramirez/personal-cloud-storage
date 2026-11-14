<script setup lang="ts">
definePageMeta({ layout: 'plain' });
useHead({ title: () => t('setup.pageTitle') });

const session = useSession();
const token = ref('');
// Se formatea mientras se escribe: XXXXX-XXXXX-XXXXX-XXXXX (mayúsculas, sin espacios ni símbolos).
watch(token, (value) => {
  const clean = value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 20);
  const formatted = clean.replace(/(.{5})(?=.)/g, '$1-');
  if (formatted !== value) token.value = formatted;
});
const username = ref('');
const password = ref('');
const repeat = ref('');
const error = liveText();
const busy = ref(false);

const MIN_LENGTH = 12;
const tooShort = computed(() => password.value.length > 0 && password.value.length < MIN_LENGTH);
const mismatch = computed(() => repeat.value.length > 0 && repeat.value !== password.value);
const ready = computed(() => token.value.trim() !== '' && username.value.trim() !== '' && password.value.length >= MIN_LENGTH && repeat.value === password.value);

async function submit(): Promise<void> {
  if (!ready.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await session.setupOwner(token.value.trim(), username.value.trim(), password.value);
    await navigateTo('/archivos', { replace: true });
  } catch (failure) {
    error.value = errorText(failure instanceof ApiError ? failure : null, 'setup.failed');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="card form" @submit.prevent="submit">
    <div>
      <h1>{{ t('setup.title') }}</h1>
      <p class="muted">{{ t('setup.lead') }}</p>
    </div>

    <div class="field">
      <label for="codigo">{{ t('setup.code') }}</label>
      <input id="codigo" v-model="token" class="input mono-input" type="text" inputmode="text" maxlength="23" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" aria-describedby="codigo-ayuda" required>
      <span id="codigo-ayuda" class="muted help">{{ t('setup.codeHelp') }}</span>
    </div>

    <div class="field">
      <label for="usuario">{{ t('setup.username') }}</label>
      <input id="usuario" v-model="username" class="input" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" pattern="[A-Za-z0-9._\-]+" maxlength="64" aria-describedby="usuario-ayuda" required>
      <span id="usuario-ayuda" class="muted help">{{ t('setup.usernameHelp') }}</span>
    </div>

    <div class="field">
      <label for="clave">{{ t('setup.password') }}</label>
      <input id="clave" v-model="password" class="input" type="password" autocomplete="new-password" aria-describedby="clave-ayuda" required>
      <span id="clave-ayuda" class="help" :class="tooShort ? 'bad' : 'muted'">{{ t('setup.passwordHelp', { n: MIN_LENGTH }) }}</span>
    </div>

    <div class="field">
      <label for="clave2">{{ t('setup.repeat') }}</label>
      <input id="clave2" v-model="repeat" class="input" type="password" autocomplete="new-password" aria-describedby="clave2-ayuda" required>
      <span v-if="mismatch" id="clave2-ayuda" class="help bad">{{ t('setup.mismatch') }}</span>
    </div>

    <p v-if="error" role="alert" class="notice notice-danger">{{ error }}</p>
    <button type="submit" class="btn btn-primary" :disabled="!ready || busy">{{ busy ? t('setup.creating') : t('setup.submit') }}</button>
  </form>
</template>

<style scoped>
.form {
  padding: 28px;
  border-radius: 18px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

h1 {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 6px;
}

.help {
  font-size: 13px;
}

.bad {
  color: var(--danger);
}

.mono-input {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: 0.04em;
}
</style>
