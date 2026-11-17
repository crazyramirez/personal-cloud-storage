<script setup lang="ts">
import type { HealthResponse, MediaCapabilities, PasskeyListResponse, PasskeyView, SessionListResponse, SessionView, UserListResponse, UserView } from '@pcloud/contracts';
import { localePreference, setLocalePreference, type LocalePreference } from '~/utils/i18n';

useHead({ title: () => t('settings.pageTitle') });
const session = useSession();
const { preference, set: setTheme } = useTheme();
const pwa = usePwa();
const isOwner = computed(() => session.user.value?.role === 'owner');

// ── Idioma ──────────────────────────────────────────────────────────────────────────────────
// «Español» y «English» se muestran siempre en su propio idioma.
const languageOptions = computed<Array<{ v: LocalePreference; l: string; lang?: string }>>(() => [
  { v: 'system', l: t('settings.languageSystem') },
  { v: 'es', l: 'Español', lang: 'es' },
  { v: 'en', l: 'English', lang: 'en' },
]);

// ── Contraseña ──────────────────────────────────────────────────────────────────────────────
const current = ref('');
const next = ref('');
const repeat = ref('');
const signOutOthers = ref(true);
const passwordBusy = ref(false);
const passwordError = liveText();

async function changePassword(): Promise<void> {
  passwordError.value = '';
  if (next.value.length < 12) return void (passwordError.value = () => t('settings.passwordTooShort'));
  if (next.value !== repeat.value) return void (passwordError.value = () => t('settings.passwordMismatch'));
  passwordBusy.value = true;
  try {
    await api('/auth/password', { method: 'POST', body: { currentPassword: current.value, newPassword: next.value, signOutOthers: signOutOthers.value } });
    current.value = next.value = repeat.value = '';
    toast(t('settings.passwordChanged'), { tone: 'ok' });
    await loadSessions();
  } catch (error) {
    passwordError.value = errorText(error instanceof ApiError ? error : null, 'settings.passwordChangeFailed');
  } finally {
    passwordBusy.value = false;
  }
}

// ── Llaves de acceso ────────────────────────────────────────────────────────────────────────
const passkeys = ref<PasskeyView[]>([]);
const passkeysSupportedHere = ref(false);
const platformAvailable = ref(false);
const passkeyBusy = ref(false);

function showError(error: unknown, fallback: string): void {
  toast(error instanceof ApiError ? error.message : fallback, { tone: 'danger' });
}

async function loadPasskeys(): Promise<void> {
  try {
    passkeys.value = (await api<PasskeyListResponse>('/auth/passkeys')).passkeys;
  } catch (error) {
    showError(error, t('settings.passkeysLoadFailed'));
  }
}

async function addPasskey(): Promise<void> {
  const name = await promptDialog({ title: t('settings.newPasskey'), label: t('settings.passkeyNameLabel'), value: suggestedPasskeyName(), confirm: t('settings.continue'), help: t('settings.passkeyNameHelp') });
  if (name === null) return;
  // Por seguridad se confirma la contraseña: con una sesión robada no se puede añadir una llave.
  const password = await promptDialog({ title: t('settings.confirmPassword'), label: t('settings.currentPassword'), confirm: t('settings.continue'), inputType: 'password', help: t('settings.confirmPasswordHelp') });
  if (password === null) return;
  passkeyBusy.value = true;
  try {
    await registerPasskey(name.trim(), password);
    toast(t('settings.passkeyAdded'), { tone: 'ok' });
    await loadPasskeys();
  } catch (error) {
    toast(passkeyErrorMessage(error), { tone: 'danger', timeoutMs: 8000 });
  } finally {
    passkeyBusy.value = false;
  }
}

async function renamePasskey(item: PasskeyView): Promise<void> {
  await promptDialog({
    title: t('settings.renamePasskey'),
    label: t('settings.name'),
    value: item.name,
    confirm: t('common.save'),
    help: ' ',
    submit: async (value) => {
      await api(`/auth/passkeys/${item.id}`, { method: 'PATCH', body: { name: value } });
    },
  });
  await loadPasskeys();
}

async function removePasskey(item: PasskeyView): Promise<void> {
  const ok = await confirmDialog({ title: t('settings.removePasskeyTitle', { name: item.name }), message: t('settings.removePasskeyMessage'), confirm: t('settings.remove'), danger: true });
  if (!ok) return;
  try {
    await api(`/auth/passkeys/${item.id}`, { method: 'DELETE' });
    toast(t('settings.passkeyRemoved'), { tone: 'ok' });
  } catch (error) {
    showError(error, t('settings.passkeyRemoveFailed'));
  }
  await loadPasskeys();
}

// ── Sesiones ────────────────────────────────────────────────────────────────────────────────
const sessions = ref<SessionView[]>([]);

async function loadSessions(): Promise<void> {
  try {
    sessions.value = (await api<SessionListResponse>('/auth/sessions')).sessions;
  } catch (error) {
    showError(error, t('settings.sessionsLoadFailed'));
  }
}

function describeAgent(agent: string | null): { device: string; icon: IconName } {
  if (agent === null) return { device: t('settings.unknownDevice'), icon: 'monitor' };
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : t('settings.browser');
  const os = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android' : /Windows/.test(agent) ? 'Windows' : /Mac OS X/.test(agent) ? 'Mac' : /Linux/.test(agent) ? 'Linux' : t('settings.otherOs');
  return { device: t('settings.agentOn', { browser, os }), icon: /iPhone|Android|iPad/.test(agent) ? 'phone' : 'monitor' };
}

async function revoke(item: SessionView): Promise<void> {
  try {
    await api(`/auth/sessions/${item.id}`, { method: 'DELETE' });
    toast(t('settings.sessionRevoked'), { tone: 'ok' });
  } catch (error) {
    showError(error, t('settings.sessionRevokeFailed'));
  }
  await loadSessions();
}

// ── Usuarios (propietario) ──────────────────────────────────────────────────────────────────
const users = ref<UserView[]>([]);
const newUser = ref({ username: '', password: '', role: 'user' as 'user' | 'owner' });
const userError = liveText();

async function loadUsers(): Promise<void> {
  if (!isOwner.value) return;
  try {
    users.value = (await api<UserListResponse>('/users')).users;
  } catch (error) {
    showError(error, t('settings.usersLoadFailed'));
  }
}

async function addUser(): Promise<void> {
  userError.value = '';
  try {
    await api('/users', { method: 'POST', body: newUser.value });
    toast(t('settings.userCreated', { name: newUser.value.username }), { tone: 'ok' });
    newUser.value = { username: '', password: '', role: 'user' };
    await loadUsers();
  } catch (error) {
    userError.value = errorText(error instanceof ApiError ? error : null, 'settings.userCreateFailed');
  }
}

async function resetPassword(item: UserView): Promise<void> {
  await promptDialog({
    title: t('settings.resetPasswordTitle', { name: item.username }),
    label: t('settings.resetPasswordLabel'),
    confirm: t('common.save'),
    help: t('settings.resetPasswordHelp'),
    inputType: 'password',
    validate: (value) => (value.length < 12 ? t('settings.minLength') : null),
    submit: async (value) => {
      await api(`/users/${item.id}/password`, { method: 'POST', body: { password: value } });
    },
  });
}

async function removeUser(item: UserView): Promise<void> {
  const ok = await confirmDialog({ title: t('settings.removeUserTitle', { name: item.username }), message: t('settings.removeUserMessage'), confirm: t('settings.removeUser'), danger: true });
  if (!ok) return;
  try {
    await api(`/users/${item.id}`, { method: 'DELETE' });
    await loadUsers();
  } catch (error) {
    toast(error instanceof ApiError ? error.message : t('settings.removeUserFailed'), { tone: 'danger' });
  }
}

// ── Sistema ─────────────────────────────────────────────────────────────────────────────────
const health = ref<HealthResponse | null>(null);

const capabilities = ref<MediaCapabilities | null>(null);
const origin = ref('');

onMounted(async () => {
  origin.value = window.location.origin;
  passkeysSupportedHere.value = passkeysSupported();
  platformAvailable.value = await platformAuthenticatorAvailable();
  await Promise.allSettled([
    loadPasskeys(),
    loadSessions(),
    loadUsers(),
    api<HealthResponse>('/system/health').then((value) => (health.value = value)),
    api<MediaCapabilities>('/media/capabilities').then((value) => (capabilities.value = value)),
  ]);
});

async function installApp(): Promise<void> {
  if (await pwa.install()) toast(t('settings.appInstalled'), { tone: 'ok' });
}
</script>

<template>
  <div class="settings">
    <header class="page-head">
      <h1>{{ t('settings.title') }}</h1>
      <p class="muted">{{ t('settings.subtitle') }}</p>
    </header>

    <div class="groups">
      <!-- ── Cuenta y seguridad ─────────────────────────────────────────────────────────── -->
      <div class="group" role="group" :aria-label="t('settings.groupAccount')">
        <p class="group-label" aria-hidden="true">{{ t('settings.groupAccount') }}</p>
        <div class="grid">
          <section id="cfg-keys" class="card sec cell" aria-labelledby="s-key">
            <header><AppIcon name="fingerprint" /><h2 id="s-key">{{ t('settings.passkeys') }}</h2></header>
            <p class="muted">{{ t('settings.passkeysIntro') }}</p>
            <p v-if="!passkeysSupportedHere" class="notice notice-warn">
              <AppIcon name="alert" /><span>{{ t('settings.passkeysUnsupportedBefore') }}<strong>https://{{ session.localName.value || t('common.serverLocalName') }}</strong>{{ t('settings.passkeysUnsupportedAfter') }}</span>
            </p>
            <ul v-if="passkeys.length > 0" class="rows">
              <li v-for="item in passkeys" :key="item.id" class="line" @contextmenu.prevent="openMenuFor($event, [{ label: t('settings.rename'), icon: 'edit', run: () => void renamePasskey(item) }, { label: t('settings.remove'), icon: 'trash', danger: true, separator: true, run: () => void removePasskey(item) }], item.name)">
                <span class="row-ico"><AppIcon name="key" :size="16" /></span>
                <span class="grow"><strong>{{ item.name }}</strong><span class="muted small">{{ t('settings.passkeyAddedOn', { date: formatDate(item.createdAt) }) }}{{ item.lastUsedAt ? t('settings.passkeyLastUsed', { date: formatDate(item.lastUsedAt) }) : t('settings.passkeyNeverUsed') }}</span></span>
                <button type="button" class="btn btn-icon" :aria-label="t('settings.rename')" @click="renamePasskey(item)"><AppIcon name="edit" /></button>
                <button type="button" class="btn btn-icon" :aria-label="t('settings.remove')" @click="removePasskey(item)"><AppIcon name="trash" /></button>
              </li>
            </ul>
            <p v-else class="muted small">{{ t('settings.noPasskeys') }}</p>
            <div class="foot">
              <button type="button" class="btn btn-primary" :disabled="!passkeysSupportedHere || passkeyBusy" @click="addPasskey">
                <AppIcon name="fingerprint" />{{ platformAvailable ? t('settings.addThisDevice') : t('settings.addPasskey') }}
              </button>
            </div>
          </section>

          <section id="cfg-password" class="card sec cell" aria-labelledby="s-pass">
            <header><AppIcon name="lock" /><h2 id="s-pass">{{ t('settings.password') }}</h2></header>
            <form class="stack" @submit.prevent="changePassword">
              <input type="text" autocomplete="username" :value="session.user.value?.username" class="sr-only" tabindex="-1" aria-hidden="true" readonly>
              <div class="field">
                <label for="p-cur">{{ t('settings.currentPassword') }}</label>
                <input id="p-cur" v-model="current" class="input" type="password" autocomplete="current-password" required>
              </div>
              <div class="pair">
                <div class="field">
                  <label for="p-new">{{ t('settings.newPassword') }}</label>
                  <input id="p-new" v-model="next" class="input" type="password" autocomplete="new-password" minlength="12" required>
                </div>
                <div class="field">
                  <label for="p-rep">{{ t('settings.repeatPassword') }}</label>
                  <input id="p-rep" v-model="repeat" class="input" type="password" autocomplete="new-password" minlength="12" required>
                </div>
              </div>
              <label class="check-line"><input v-model="signOutOthers" type="checkbox"> {{ t('settings.signOutOthers') }}</label>
              <p v-if="passwordError" role="alert" class="notice notice-danger">{{ passwordError }}</p>
              <div class="foot">
                <button type="submit" class="btn btn-primary" :disabled="passwordBusy">{{ passwordBusy ? t('settings.saving') : t('settings.changePassword') }}</button>
              </div>
            </form>
          </section>

          <section id="cfg-sessions" class="card sec cell" :class="{ 'span-2': !isOwner }" aria-labelledby="s-ses">
            <header><AppIcon name="monitor" /><h2 id="s-ses">{{ t('settings.sessions') }}</h2></header>
            <ul class="rows">
              <li v-for="item in sessions" :key="item.id" class="line">
                <span class="row-ico"><AppIcon :name="describeAgent(item.userAgent).icon" :size="16" /></span>
                <span class="grow">
                  <strong>{{ describeAgent(item.userAgent).device }}</strong>
                  <span class="muted small">{{ item.current ? t('settings.thisDevice') : t('settings.lastActivity', { date: formatDate(item.lastSeenAt) }) }}{{ item.ip ? ` · ${item.ip}` : '' }}</span>
                </span>
                <span v-if="item.current" class="chip chip-ok">{{ t('settings.current') }}</span>
                <button v-else type="button" class="btn" @click="revoke(item)">{{ t('settings.revoke') }}</button>
              </li>
            </ul>
          </section>

          <section v-if="isOwner" id="cfg-users" class="card sec cell" aria-labelledby="s-users">
            <header><AppIcon name="users" /><h2 id="s-users">{{ t('settings.users') }}</h2></header>
            <p class="muted">{{ t('settings.usersIntro') }}</p>
            <ul class="rows">
              <li v-for="item in users" :key="item.id" class="line">
                <span class="row-ico"><AppIcon name="user" :size="16" /></span>
                <span class="grow">
                  <strong>{{ item.username }}</strong>
                  <span class="muted small">{{ item.role === 'owner' ? t('settings.owner') : t('settings.user') }} · {{ t('settings.keyCount', { n: item.passkeys }) }} · {{ t('settings.since', { date: formatDate(item.createdAt) }) }}</span>
                </span>
                <button type="button" class="btn" @click="resetPassword(item)">{{ t('settings.password') }}</button>
                <button v-if="item.username !== session.user.value?.username" type="button" class="btn btn-icon" :aria-label="t('settings.removeUser')" @click="removeUser(item)"><AppIcon name="trash" /></button>
              </li>
            </ul>
            <form class="adduser" @submit.prevent="addUser">
              <input v-model="newUser.username" class="input" type="text" :placeholder="t('settings.usernamePlaceholder')" :aria-label="t('settings.newUsername')" autocomplete="off" pattern="[A-Za-z0-9._\-]+" required>
              <input v-model="newUser.password" class="input" type="password" :placeholder="t('settings.passwordPlaceholder')" :aria-label="t('settings.newUserPassword')" autocomplete="new-password" minlength="12" required>
              <select v-model="newUser.role" class="input" :aria-label="t('settings.role')">
                <option value="user">{{ t('settings.user') }}</option>
                <option value="owner">{{ t('settings.owner') }}</option>
              </select>
              <button type="submit" class="btn">{{ t('settings.add') }}</button>
            </form>
            <p v-if="userError" role="alert" class="notice notice-danger">{{ userError }}</p>
          </section>
        </div>
      </div>

      <!-- ── Preferencias ───────────────────────────────────────────────────────────────── -->
      <div class="group" role="group" :aria-label="t('settings.groupPreferences')">
        <p class="group-label" aria-hidden="true">{{ t('settings.groupPreferences') }}</p>
        <div class="grid three">
          <section id="cfg-language" class="card sec cell" aria-labelledby="s-lang">
            <header><AppIcon name="globe" /><h2 id="s-lang">{{ t('settings.language') }}</h2></header>
            <div class="seg" role="radiogroup" aria-labelledby="s-lang">
              <button v-for="option in languageOptions" :key="option.v" type="button" role="radio" :aria-checked="localePreference === option.v" :lang="option.lang" @click="setLocalePreference(option.v)">{{ option.l }}</button>
            </div>
            <p v-if="localePreference === 'system'" class="muted small" aria-live="polite">{{ t('settings.languageNow', { name: t('common.languageName') }) }}</p>
          </section>

          <section id="cfg-look" class="card sec cell" aria-labelledby="s-look">
            <header><AppIcon name="sun" /><h2 id="s-look">{{ t('settings.appearance') }}</h2></header>
            <div class="seg" role="radiogroup" :aria-label="t('settings.theme')">
              <button v-for="option in [{ v: 'system', l: t('settings.themeSystem') }, { v: 'light', l: t('settings.themeLight') }, { v: 'dark', l: t('settings.themeDark') }]" :key="option.v" type="button" role="radio" :aria-checked="preference === option.v" @click="setTheme(option.v as 'system' | 'light' | 'dark')">{{ option.l }}</button>
            </div>
          </section>

          <section id="cfg-app" class="card sec cell" aria-labelledby="s-app">
            <header><AppIcon name="install" /><h2 id="s-app">{{ t('settings.app') }}</h2></header>
            <p v-if="pwa.installed.value" class="notice notice-info"><AppIcon name="check" class="accent" /><span>{{ t('settings.usingInstalled') }}</span></p>
            <template v-else>
              <p class="muted">{{ t('settings.installIntro') }}</p>
              <button v-if="pwa.canInstall.value" type="button" class="btn btn-primary" @click="installApp"><AppIcon name="install" />{{ t('settings.installApp') }}</button>
              <p v-else-if="pwa.isIos" class="notice notice-info"><AppIcon name="info" class="accent" /><span>{{ t('settings.iosBefore') }}<strong>{{ t('settings.iosShare') }}</strong>{{ t('settings.iosMiddle') }}<strong>{{ t('settings.iosAddHome') }}</strong>{{ t('settings.iosAfter') }}</span></p>
              <p v-else class="muted small">{{ t('settings.installFallback') }}</p>
            </template>
          </section>
        </div>
      </div>

      <!-- ── Nube (propietario) ─────────────────────────────────────────────────────────── -->
      <div v-if="isOwner" class="group" role="group" :aria-label="t('settings.groupCloud')">
        <p class="group-label" aria-hidden="true">{{ t('settings.groupCloud') }}</p>
        <div class="grid">
          <div id="cfg-backup" class="cell span-2"><BackupSettings /></div>
          <div id="cfg-shares" class="cell span-2"><SharesSettings /></div>
        </div>
      </div>

      <!-- ── Equipo ─────────────────────────────────────────────────────────────────────── -->
      <div class="group" role="group" :aria-label="t('settings.groupDevice')">
        <p class="group-label" aria-hidden="true">{{ t('settings.groupDevice') }}</p>
        <div class="grid">
          <section id="cfg-server" class="card sec cell" :class="{ 'span-2': !isOwner }" aria-labelledby="s-sys">
            <header><AppIcon name="drive" /><h2 id="s-sys">{{ t('settings.server') }}</h2></header>
            <dl class="kv">
              <dt>{{ t('settings.address') }}</dt>
              <dd class="mono selectable">{{ origin }}</dd>
              <dt>{{ t('settings.version') }}</dt>
              <dd class="selectable">
                <strong>{{ health?.version ?? '…' }}</strong>
                <span class="muted mono small"> · {{ health?.release ?? t('settings.development') }}</span>
              </dd>
              <dt>{{ t('settings.media') }}</dt>
              <dd>{{ capabilities === null ? '…' : capabilities.ffmpeg ? `${t('settings.transcodeAvailable')}${capabilities.hardwareVideo ? t('settings.hardwareAccel') : ''}` : t('settings.browserFormatsOnly') }}</dd>
              <dt>{{ t('settings.documents') }}</dt>
              <dd>{{ capabilities === null ? '…' : capabilities.office ? t('settings.officeAvailable') : t('settings.pdfTextOnly') }}</dd>
              <dt>{{ t('settings.certificate') }}</dt>
              <dd><a href="/pcloud-ca.crt" download>{{ t('settings.downloadCert') }}</a>{{ t('settings.certAfter') }}</dd>
            </dl>
          </section>
          <div v-if="isOwner" id="cfg-power" class="cell"><PowerSettings /></div>
          <div v-if="isOwner" id="cfg-speed" class="cell span-2"><DiskSpeedTest /></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── Estructura: grupos de tarjetas en rejilla ──────────────────────────────────────────── */
.settings {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 20px;
  width: 100%;
  max-width: 1440px;
}

.page-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

h1 {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.page-head p {
  font-size: 14px;
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 30px;
  min-width: 0;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.group-label {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
  padding-left: 2px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: stretch;
}

.span-2 {
  grid-column: span 2;
}

/* Las tarjetas llenan su celda: las de una misma fila tienen la misma altura. */
.cell {
  min-width: 0;
}

div.cell {
  display: flex;
  flex-direction: column;
}

div.cell > :deep(.card) {
  flex: 1;
}

@media (min-width: 1180px) {
  .grid.three {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 900px) {
  .grid,
  .grid.three {
    grid-template-columns: minmax(0, 1fr);
  }

  .span-2 {
    grid-column: auto;
  }
}

/* ── Tarjetas: la misma cabecera en todas (también en las de los componentes) ───────────── */
.sec {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
}

.groups :deep(.sec > header) {
  display: flex;
  align-items: center;
  gap: 12px;
}

.groups :deep(.sec > header > svg:first-child) {
  box-sizing: content-box;
  flex: none;
  padding: 8px;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
}

.groups :deep(.sec > header h2) {
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

/* El pie (botón principal) siempre abajo: las tarjetas de una fila quedan alineadas. */
.foot {
  margin-top: auto;
  display: flex;
  gap: 10px;
}

/* ── Filas (llaves, sesiones, usuarios) ──────────────────────────────────────────────────── */
.rows {
  display: flex;
  flex-direction: column;
}

.line {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
}

.row-ico {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: var(--surface-2);
  color: var(--muted);
}

.grow {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.grow strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.small {
  font-size: 12px;
}

/* ── Formularios ─────────────────────────────────────────────────────────────────────────── */
.stack {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.check-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.adduser {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: auto;
}

/* ── Selector segmentado (idioma, tema): todo el ancho de su tarjeta ────────────────────── */
.seg {
  display: flex;
  flex-wrap: wrap;
  width: 100%;
  padding: 3px;
  gap: 3px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--surface-2);
}

.seg button {
  flex: 1 1 auto;
  min-height: 36px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-weight: 600;
  font-size: 13.5px;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.seg button:hover {
  color: var(--text);
}

.seg button[aria-checked='true'] {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%), 0 0 0 1px var(--border);
}

.seg button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

@media (max-width: 640px) {
  .pair,
  .adduser {
    grid-template-columns: minmax(0, 1fr);
  }

  .seg button {
    min-height: 44px;
  }
}
</style>
