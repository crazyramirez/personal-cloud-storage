<script setup lang="ts">
definePageMeta({ layout: 'plain' });
useHead({ title: () => t('auth.pageTitle') });

const session = useSession();
const route = useRoute();
const username = ref('');
const password = ref('');
const error = liveText();
const busy = ref(false);
const passkeyReady = ref(false);
let conditional: AbortController | null = null;
/** Petición de autocompletado en curso: hay que esperar a que se cancele antes de lanzar otra. */
let conditionalRun: Promise<unknown> | null = null;

/** Solo se vuelve a rutas internas (evita redirecciones a otros sitios). */
function target(): string {
  const back = route.query.volver;
  return typeof back === 'string' && back.startsWith('/') && !back.startsWith('//') && !back.includes('\\') ? back : '/archivos';
}

async function finish(): Promise<void> {
  conditional?.abort();
  await navigateTo(target(), { replace: true });
}

async function submit(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await session.login(username.value.trim(), password.value);
    await finish();
  } catch (failure) {
    error.value = errorText(failure instanceof ApiError ? failure : null, 'auth.loginFailed');
    password.value = '';
  } finally {
    busy.value = false;
  }
}

async function withPasskey(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  // Una sola petición de WebAuthn a la vez: Safari rechaza (o deja colgada) una nueva mientras
  // la del autocompletado no haya terminado de cancelarse.
  conditional?.abort();
  await conditionalRun?.catch(() => undefined);
  try {
    session.adopt(await loginWithPasskey());
    await finish();
  } catch (failure) {
    error.value = () => passkeyErrorMessage(failure);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  passkeyReady.value = passkeysSupported();
  // Autocompletado: el navegador ofrece las llaves guardadas al tocar el campo de usuario.
  if (await conditionalMediationAvailable()) {
    conditional = new AbortController();
    try {
      const run = loginWithPasskey({ conditional: true, signal: conditional.signal });
      conditionalRun = run;
      const user = await run;
      session.adopt(user);
      await finish();
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) {
        if (failure instanceof ApiError) error.value = () => failure.message;
      }
    }
  }
});
onBeforeUnmount(() => conditional?.abort());
</script>

<template>
  <form class="card form" @submit.prevent="submit">
    <div>
      <h1>{{ t('auth.title') }}</h1>
      <p class="muted">{{ t('auth.subtitle') }}</p>
    </div>
    <button v-if="passkeyReady" type="button" class="btn btn-primary big" :disabled="busy" @click="withPasskey">
      <AppIcon name="fingerprint" :size="20" />{{ t('auth.withPasskey') }}
    </button>
    <p v-if="passkeyReady" class="muted small">{{ t('auth.passkeyHint') }}</p>
    <div v-if="passkeyReady" class="or" aria-hidden="true"><span>{{ t('auth.orPassword') }}</span></div>
    <div class="field">
      <label for="usuario">{{ t('auth.username') }}</label>
      <input id="usuario" v-model="username" class="input" type="text" autocomplete="username webauthn" autocapitalize="none" spellcheck="false" required>
    </div>
    <div class="field">
      <label for="clave">{{ t('auth.password') }}</label>
      <input id="clave" v-model="password" class="input" type="password" autocomplete="current-password" required>
    </div>
    <p v-if="error" role="alert" class="notice notice-danger">{{ error }}</p>
    <button type="submit" class="btn" :class="passkeyReady ? '' : 'btn-primary'" :disabled="busy">{{ busy ? t('auth.checking') : t('auth.submit') }}</button>
    <p v-if="!passkeyReady" class="muted small">{{ t('auth.passkeyUnsupportedBefore') }}<strong>https://{{ session.localName.value || t('common.serverLocalName') }}</strong>{{ t('auth.passkeyUnsupportedAfter') }}</p>
  </form>
</template>

<style scoped>
.form {
  padding: 28px;
  border-radius: 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

h1 {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.big {
  min-height: 48px;
  font-size: 15px;
}

.small {
  font-size: 12px;
  margin-top: -8px;
}

.or {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--muted);
  font-size: 12px;
}

.or::before,
.or::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}
</style>
