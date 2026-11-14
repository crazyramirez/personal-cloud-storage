<script setup lang="ts">
import type { DiskSpeedResponse, HealthResponse, MediaCapabilities, PasskeyListResponse, PasskeyView, SessionListResponse, SessionView, UserListResponse, UserView } from '@pcloud/contracts';
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

// ── Velocidad del disco ─────────────────────────────────────────────────────────────────────
const speed = ref<DiskSpeedResponse | null>(null);
const speedBusy = ref(false);
const speedError = liveText();
const SPEED_KEY = 'pcloud.diskspeed';
try {
  const saved = JSON.parse(localStorage.getItem(SPEED_KEY) ?? 'null') as DiskSpeedResponse | null;
  if (saved !== null && typeof saved.readMBps === 'number') speed.value = saved;
} catch {
  // ignorar
}

async function runSpeedTest(): Promise<void> {
  speedBusy.value = true;
  speedError.value = '';
  try {
    speed.value = await api<DiskSpeedResponse>('/system/disk-speed', { method: 'POST', timeoutMs: 240_000 });
    try {
      localStorage.setItem(SPEED_KEY, JSON.stringify(speed.value));
    } catch {
      // ignorar
    }
  } catch (error) {
    speedError.value = errorText(error instanceof ApiError ? error : null, 'settings.speedFailed');
  } finally {
    speedBusy.value = false;
  }
}

/** Escala visual: un HDD USB 3 de 2,5" ronda 100-130 MB/s secuencial; 150 = barra llena. */
const barPercent = (value: number, max: number): number => Math.max(3, Math.min(100, Math.round((value / max) * 100)));
const verdict = (mbps: number): string => t(mbps >= 80 ? 'settings.verdictGreat' : mbps >= 40 ? 'settings.verdictOk' : mbps >= 15 ? 'settings.verdictSlow' : 'settings.verdictVerySlow');
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
  <div class="page">
    <h1>{{ t('settings.title') }}</h1>

    <section class="card sec" aria-labelledby="s-lang">
      <header><AppIcon name="globe" /><h2 id="s-lang">{{ t('settings.language') }}</h2></header>
      <div class="seg" role="radiogroup" aria-labelledby="s-lang">
        <button v-for="option in languageOptions" :key="option.v" type="button" role="radio" :aria-checked="localePreference === option.v" :lang="option.lang" @click="setLocalePreference(option.v)">{{ option.l }}</button>
      </div>
      <p v-if="localePreference === 'system'" class="muted small" aria-live="polite">{{ t('settings.languageNow', { name: t('common.languageName') }) }}</p>
    </section>

    <section class="card sec" aria-labelledby="s-key">
      <header><AppIcon name="fingerprint" /><h2 id="s-key">{{ t('settings.passkeys') }}</h2></header>
      <p class="muted">{{ t('settings.passkeysIntro') }}</p>
      <p v-if="!passkeysSupportedHere" class="notice notice-warn">
        <AppIcon name="alert" /><span>{{ t('settings.passkeysUnsupportedBefore') }}<strong>https://{{ session.localName.value || t('common.serverLocalName') }}</strong>{{ t('settings.passkeysUnsupportedAfter') }}</span>
      </p>
      <ul v-if="passkeys.length > 0" class="rows">
        <li v-for="item in passkeys" :key="item.id" class="line" @contextmenu.prevent="openMenuFor($event, [{ label: t('settings.rename'), icon: 'edit', run: () => void renamePasskey(item) }, { label: t('settings.remove'), icon: 'trash', danger: true, separator: true, run: () => void removePasskey(item) }], item.name)">
          <AppIcon name="key" class="accent" />
          <span class="grow"><strong>{{ item.name }}</strong><span class="muted small">{{ t('settings.passkeyAddedOn', { date: formatDate(item.createdAt) }) }}{{ item.lastUsedAt ? t('settings.passkeyLastUsed', { date: formatDate(item.lastUsedAt) }) : t('settings.passkeyNeverUsed') }}</span></span>
          <button type="button" class="btn btn-icon" :aria-label="t('settings.rename')" @click="renamePasskey(item)"><AppIcon name="edit" /></button>
          <button type="button" class="btn btn-icon" :aria-label="t('settings.remove')" @click="removePasskey(item)"><AppIcon name="trash" /></button>
        </li>
      </ul>
      <p v-else class="muted small">{{ t('settings.noPasskeys') }}</p>
      <div>
        <button type="button" class="btn btn-primary" :disabled="!passkeysSupportedHere || passkeyBusy" @click="addPasskey">
          <AppIcon name="fingerprint" />{{ platformAvailable ? t('settings.addThisDevice') : t('settings.addPasskey') }}
        </button>
      </div>
    </section>

    <section class="card sec" aria-labelledby="s-pass">
      <header><AppIcon name="lock" /><h2 id="s-pass">{{ t('settings.password') }}</h2></header>
      <form class="grid2" @submit.prevent="changePassword">
        <input type="text" autocomplete="username" :value="session.user.value?.username" class="sr-only" tabindex="-1" aria-hidden="true" readonly>
        <div class="field">
          <label for="p-cur">{{ t('settings.currentPassword') }}</label>
          <input id="p-cur" v-model="current" class="input" type="password" autocomplete="current-password" required>
        </div>
        <div />
        <div class="field">
          <label for="p-new">{{ t('settings.newPassword') }}</label>
          <input id="p-new" v-model="next" class="input" type="password" autocomplete="new-password" minlength="12" required>
        </div>
        <div class="field">
          <label for="p-rep">{{ t('settings.repeatPassword') }}</label>
          <input id="p-rep" v-model="repeat" class="input" type="password" autocomplete="new-password" minlength="12" required>
        </div>
        <label class="check-line"><input v-model="signOutOthers" type="checkbox"> {{ t('settings.signOutOthers') }}</label>
        <div class="end">
          <button type="submit" class="btn btn-primary" :disabled="passwordBusy">{{ passwordBusy ? t('settings.saving') : t('settings.changePassword') }}</button>
        </div>
        <p v-if="passwordError" role="alert" class="notice notice-danger wide">{{ passwordError }}</p>
      </form>
    </section>

    <section class="card sec" aria-labelledby="s-ses">
      <header><AppIcon name="monitor" /><h2 id="s-ses">{{ t('settings.sessions') }}</h2></header>
      <ul class="rows">
        <li v-for="item in sessions" :key="item.id" class="line">
          <AppIcon :name="describeAgent(item.userAgent).icon" class="muted" />
          <span class="grow">
            <strong>{{ describeAgent(item.userAgent).device }}</strong>
            <span class="muted small">{{ item.current ? t('settings.thisDevice') : t('settings.lastActivity', { date: formatDate(item.lastSeenAt) }) }}{{ item.ip ? ` · ${item.ip}` : '' }}</span>
          </span>
          <span v-if="item.current" class="chip chip-ok">{{ t('settings.current') }}</span>
          <button v-else type="button" class="btn" @click="revoke(item)">{{ t('settings.revoke') }}</button>
        </li>
      </ul>
    </section>

    <section v-if="isOwner" class="card sec" aria-labelledby="s-users">
      <header><AppIcon name="users" /><h2 id="s-users">{{ t('settings.users') }}</h2></header>
      <p class="muted">{{ t('settings.usersIntro') }}</p>
      <ul class="rows">
        <li v-for="item in users" :key="item.id" class="line">
          <AppIcon name="user" class="muted" />
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

    <section class="card sec" aria-labelledby="s-look">
      <header><AppIcon name="sun" /><h2 id="s-look">{{ t('settings.appearance') }}</h2></header>
      <div class="seg" role="radiogroup" :aria-label="t('settings.theme')">
        <button v-for="option in [{ v: 'system', l: t('settings.themeSystem') }, { v: 'light', l: t('settings.themeLight') }, { v: 'dark', l: t('settings.themeDark') }]" :key="option.v" type="button" role="radio" :aria-checked="preference === option.v" @click="setTheme(option.v as 'system' | 'light' | 'dark')">{{ option.l }}</button>
      </div>
    </section>

    <section class="card sec" aria-labelledby="s-app">
      <header><AppIcon name="install" /><h2 id="s-app">{{ t('settings.app') }}</h2></header>
      <p v-if="pwa.installed.value" class="notice notice-info"><AppIcon name="check" class="accent" /><span>{{ t('settings.usingInstalled') }}</span></p>
      <template v-else>
        <p class="muted">{{ t('settings.installIntro') }}</p>
        <button v-if="pwa.canInstall.value" type="button" class="btn btn-primary" @click="installApp"><AppIcon name="install" />{{ t('settings.installApp') }}</button>
        <p v-else-if="pwa.isIos" class="notice notice-info"><AppIcon name="info" class="accent" /><span>{{ t('settings.iosBefore') }}<strong>{{ t('settings.iosShare') }}</strong>{{ t('settings.iosMiddle') }}<strong>{{ t('settings.iosAddHome') }}</strong>{{ t('settings.iosAfter') }}</span></p>
        <p v-else class="muted small">{{ t('settings.installFallback') }}</p>
      </template>
    </section>

    <BackupSettings v-if="isOwner" />

    <section v-if="isOwner" class="card sec" aria-labelledby="s-speed">
      <header><AppIcon name="gauge" /><h2 id="s-speed">{{ t('settings.diskSpeed') }}</h2></header>
      <p class="muted">{{ t('settings.diskSpeedIntro') }}</p>
      <div v-if="speed" class="speed">
        <div class="meter">
          <div class="meter-head"><span>{{ t('settings.write') }}</span><strong>{{ formatNumber(speed.writeMBps, 3) }} MB/s</strong></div>
          <div class="bar"><span :style="{ width: `${barPercent(speed.writeMBps, 150)}%` }" /></div>
          <span class="muted small">{{ verdict(speed.writeMBps) }}</span>
        </div>
        <div class="meter">
          <div class="meter-head"><span>{{ t('settings.read') }}</span><strong>{{ formatNumber(speed.readMBps, 3) }} MB/s</strong></div>
          <div class="bar"><span :style="{ width: `${barPercent(speed.readMBps, 150)}%` }" /></div>
          <span class="muted small">{{ verdict(speed.readMBps) }}</span>
        </div>
        <div class="meter">
          <div class="meter-head"><span>{{ t('settings.randomAccess') }}</span><strong>{{ formatNumber(speed.randomReadIops, 3) }} IOPS</strong></div>
          <div class="bar"><span :style="{ width: `${barPercent(speed.randomReadIops, 200)}%` }" /></div>
          <span class="muted small">{{ t('settings.randomHint') }}</span>
        </div>
        <p class="muted small">{{ t('settings.measuredAt', { date: formatDate(speed.testedAt), seconds: formatNumber(speed.durationMs / 1000) }) }}</p>
      </div>
      <p v-if="speedError" role="alert" class="notice notice-danger">{{ speedError }}</p>
      <div>
        <button type="button" class="btn btn-primary" :disabled="speedBusy" @click="runSpeedTest">
          <span v-if="speedBusy" class="spin" aria-hidden="true" /><AppIcon v-else name="gauge" />{{ speedBusy ? t('settings.measuring') : speed ? t('settings.measureAgain') : t('settings.measure') }}
        </button>
      </div>
    </section>

    <section class="card sec" aria-labelledby="s-sys">
      <header><AppIcon name="drive" /><h2 id="s-sys">{{ t('settings.server') }}</h2></header>
      <dl class="kv">
        <dt>{{ t('settings.address') }}</dt>
        <dd class="mono selectable">{{ origin }}</dd>
        <dt>{{ t('settings.version') }}</dt>
        <dd class="mono selectable">{{ health?.release ?? t('settings.development') }}</dd>
        <dt>{{ t('settings.media') }}</dt>
        <dd>{{ capabilities === null ? '…' : capabilities.ffmpeg ? `${t('settings.transcodeAvailable')}${capabilities.hardwareVideo ? t('settings.hardwareAccel') : ''}` : t('settings.browserFormatsOnly') }}</dd>
        <dt>{{ t('settings.documents') }}</dt>
        <dd>{{ capabilities === null ? '…' : capabilities.office ? t('settings.officeAvailable') : t('settings.pdfTextOnly') }}</dd>
        <dt>{{ t('settings.certificate') }}</dt>
        <dd><a href="/pcloud-ca.crt" download>{{ t('settings.downloadCert') }}</a>{{ t('settings.certAfter') }}</dd>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 860px;
}

h1 {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.sec {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
}

.sec header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sec h2 {
  font-size: 17px;
  font-weight: 650;
}

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

.grow {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.small {
  font-size: 12px;
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  align-items: end;
}

.check-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.end {
  display: flex;
  justify-content: flex-end;
}

.wide {
  grid-column: 1 / -1;
}

.adduser {
  display: grid;
  grid-template-columns: 1fr 1fr 140px auto;
  gap: 8px;
}

.speed {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.meter {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meter-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.meter-head strong {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}

.meter .bar {
  height: 10px;
  border-radius: 5px;
  background: var(--track);
  overflow: hidden;
}

.meter .bar span {
  display: block;
  height: 100%;
  border-radius: 5px;
  background: linear-gradient(90deg, var(--accent-btn), #7b4dd6);
  transition: width 0.6s cubic-bezier(0.2, 0.9, 0.3, 1);
}

.spin {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  align-self: flex-start;
}

.seg button {
  padding: 8px 14px;
  border: 0;
  background: var(--surface);
  font-weight: 500;
}

.seg button[aria-checked='true'] {
  background: var(--accent-soft);
  color: var(--accent);
}

@media (max-width: 640px) {
  .grid2,
  .adduser {
    grid-template-columns: 1fr;
  }

  .seg {
    flex-wrap: wrap;
  }

  .seg button {
    flex: 1 1 auto;
    min-height: 44px;
  }
}
</style>
