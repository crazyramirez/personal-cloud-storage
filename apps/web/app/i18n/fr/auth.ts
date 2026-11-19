import type { Translation } from '~/utils/i18n';
import type source from '../auth';

export default {
  pageTitle: 'Connexion · Personal Cloud',
  title: 'Connexion',
  subtitle: 'Accédez à votre cloud personnel.',
  withPasskey: 'Se connecter avec une clé d’accès',
  passkeyHint: 'Face ID, Touch ID, Windows Hello ou l’empreinte de votre téléphone.',
  orPassword: 'ou avec un mot de passe',
  username: 'Nom d’utilisateur',
  password: 'Mot de passe',
  checking: 'Vérification…',
  submit: 'Se connecter',
  passkeyUnsupportedBefore: 'Pour vous connecter avec Face ID ou Windows Hello, ouvrez ',
  passkeyUnsupportedAfter: ' (pas l’adresse IP) avec le certificat installé.',
  loginFailed: 'Impossible de se connecter',
  thisDevice: 'Cet appareil',
  cancelled: 'Opération annulée',
  passkeyTimeout: 'La demande a été annulée ou a expiré. Veuillez réessayer.',
  passkeyExists: 'Cet appareil possède déjà une clé d’accès enregistrée pour votre compte.',
  passkeyInsecure: 'Le navigateur n’autorise pas les clés d’accès ici : ouvrez l’application par son nom .local en HTTPS avec le certificat installé.',
  passkeyFailed: 'Impossible de terminer l’opération',
} satisfies Translation<typeof source>;
