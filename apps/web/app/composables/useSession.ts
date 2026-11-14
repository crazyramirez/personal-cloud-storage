import type { SessionUser, SetupStatus } from '@pcloud/contracts';

// Estado de aplicación (SPA sin SSR: un único usuario por pestaña).
const user = ref<SessionUser | null>(null);
const needsOwner = ref(false);
/** Nombre .local del servidor, para indicar cómo abrir la app con llaves de acceso. */
const localName = ref('');
const checked = ref(false);

export function useSession() {
  /** Averigua si falta la configuración inicial y si hay sesión abierta. */
  async function refresh(): Promise<void> {
    const setup = await api<SetupStatus>('/setup/status');
    needsOwner.value = setup.needsOwner;
    localName.value = setup.localName;
    if (setup.needsOwner) {
      user.value = null;
    } else {
      try {
        user.value = await api<SessionUser>('/auth/me', { handle401: false });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) user.value = null;
        else throw error;
      }
    }
    checked.value = true;
  }

  async function login(username: string, password: string): Promise<void> {
    user.value = await api<SessionUser>('/auth/login', { method: 'POST', body: { username, password }, handle401: false });
  }

  async function setupOwner(token: string, username: string, password: string): Promise<void> {
    user.value = await api<SessionUser>('/setup/owner', { method: 'POST', body: { token, username, password }, handle401: false });
    needsOwner.value = false;
  }

  async function logout(): Promise<void> {
    await api('/auth/logout', { method: 'POST', handle401: false }).catch(() => undefined);
    user.value = null;
  }

  function expire(): void {
    user.value = null;
  }

  /** Sesión abierta por otra vía (llave de acceso). */
  function adopt(next: SessionUser): void {
    user.value = next;
  }

  return { user, needsOwner, localName, checked, refresh, login, setupOwner, logout, expire, adopt };
}
