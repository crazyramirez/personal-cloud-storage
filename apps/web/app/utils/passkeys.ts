/**
 * Llaves de acceso (WebAuthn): Face ID, Touch ID, Windows Hello, huella del móvil.
 * La biometría la hace el dispositivo; aquí solo viajan retos y firmas.
 */
import type { PasskeyLoginOptions, PasskeyRegisterOptions, SessionUser } from '@pcloud/contracts';

function toBytes(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function toB64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** El navegador y el contexto permiten llaves de acceso (HTTPS con nombre, no IP). */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof window.PublicKeyCredential === 'function' && !/^\d+\.\d+\.\d+\.\d+$/.test(window.location.hostname);
}

/** El dispositivo tiene un autenticador integrado (Face ID, Windows Hello…). */
export async function platformAuthenticatorAvailable(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function conditionalMediationAvailable(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  const pkc = PublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> };
  try {
    return (await pkc.isConditionalMediationAvailable?.()) === true;
  } catch {
    return false;
  }
}

/** Nombre sugerido para la llave según el dispositivo. */
export function suggestedPasskeyName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows Hello';
  if (/Mac OS X/.test(ua)) return 'Mac';
  return t('auth.thisDevice');
}

export async function registerPasskey(name: string, password: string): Promise<void> {
  const options = await api<PasskeyRegisterOptions>('/auth/passkeys/register/options', { method: 'POST', body: { password } });
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: toBytes(options.challenge),
      rp: options.rp,
      user: { id: toBytes(options.user.id), name: options.user.name, displayName: options.user.displayName },
      pubKeyCredParams: options.pubKeyCredParams,
      excludeCredentials: options.excludeCredentials.map((item) => ({ type: 'public-key' as const, id: toBytes(item.id) })),
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none',
      timeout: options.timeout,
    },
  })) as PublicKeyCredential | null;
  if (credential === null) throw new Error(t('auth.cancelled'));
  const response = credential.response as AuthenticatorAttestationResponse;
  await api('/auth/passkeys/register', {
    method: 'POST',
    body: { name, id: toB64Url(credential.rawId), clientDataJSON: toB64Url(response.clientDataJSON), attestationObject: toB64Url(response.attestationObject) },
  });
}

/**
 * Entra con una llave de acceso. `conditional`: se ofrece en el autocompletado del campo de
 * usuario sin abrir ventanas (se resuelve cuando el usuario la elige).
 */
export async function loginWithPasskey(options: { conditional?: boolean; signal?: AbortSignal } = {}): Promise<SessionUser> {
  const challenge = await api<PasskeyLoginOptions>('/auth/passkeys/login/options', { method: 'POST', handle401: false });
  const credential = (await navigator.credentials.get({
    mediation: options.conditional === true ? ('conditional' as CredentialMediationRequirement) : 'optional',
    signal: options.signal,
    publicKey: { challenge: toBytes(challenge.challenge), rpId: challenge.rpId, userVerification: 'required', timeout: challenge.timeout, allowCredentials: [] },
  })) as PublicKeyCredential | null;
  if (credential === null) throw new Error(t('auth.cancelled'));
  const response = credential.response as AuthenticatorAssertionResponse;
  return api<SessionUser>('/auth/passkeys/login', {
    method: 'POST',
    handle401: false,
    body: {
      id: toB64Url(credential.rawId),
      clientDataJSON: toB64Url(response.clientDataJSON),
      authenticatorData: toB64Url(response.authenticatorData),
      signature: toB64Url(response.signature),
      ...(response.userHandle === null ? {} : { userHandle: toB64Url(response.userHandle) }),
    },
  });
}

/** Mensaje comprensible para los errores de WebAuthn. */
export function passkeyErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') return t('auth.passkeyTimeout');
    if (error.name === 'InvalidStateError') return t('auth.passkeyExists');
    if (error.name === 'SecurityError') return t('auth.passkeyInsecure');
  }
  return error instanceof Error ? error.message : t('auth.passkeyFailed');
}
