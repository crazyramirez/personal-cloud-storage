import type { Translation } from '~/utils/i18n';
import type source from '../auth';

export default {
  pageTitle: 'Anmelden · Personal Cloud',
  title: 'Anmelden',
  subtitle: 'Zugriff auf Ihre persönliche Cloud.',
  withPasskey: 'Mit Passkey anmelden',
  passkeyHint: 'Face ID, Touch ID, Windows Hello oder der Fingerabdruck Ihres Smartphones.',
  orPassword: 'oder mit Passwort',
  username: 'Nutzername',
  password: 'Passwort',
  checking: 'Wird geprüft…',
  submit: 'Anmelden',
  passkeyUnsupportedBefore: 'Um sich mit Face ID oder Windows Hello anzumelden, öffnen Sie ',
  passkeyUnsupportedAfter: ' (nicht die IP-Adresse) mit installiertem Zertifikat.',
  loginFailed: 'Anmeldung fehlgeschlagen',
  thisDevice: 'Dieses Gerät',
  cancelled: 'Vorgang abgebrochen',
  passkeyTimeout: 'Abgebrochen oder Zeit abgelaufen. Bitte versuchen Sie es erneut.',
  passkeyExists: 'Für Ihr Konto ist auf diesem Gerät bereits ein Passkey registriert.',
  passkeyInsecure: 'Der Browser erlaubt hier keine Passkeys. Öffnen Sie die App über ihren .local-Namen per HTTPS mit installiertem Zertifikat.',
  passkeyFailed: 'Vorgang konnte nicht abgeschlossen werden',
} satisfies Translation<typeof source>;
