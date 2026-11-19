import type { Translation } from '~/utils/i18n';
import type source from '../setup';

export default {
  pageTitle: 'Configuration initiale · Personal Cloud',
  title: 'Créez le compte propriétaire',
  lead: 'C’est le compte qui a un accès complet à votre cloud. Le mot de passe ne peut pas être récupéré par e-mail : conservez-le en lieu sûr.',
  code: 'Code de configuration',
  codeHelp: 'Code à usage unique fourni par le serveur lors de son installation (valable 24 h). Il prouve que vous avez accès au Raspberry Pi.',
  username: 'Nom d’utilisateur',
  usernameHelp: 'Lettres, chiffres, point, tiret et tiret bas.',
  password: 'Mot de passe',
  passwordHelp: 'Au moins {n} caractères. Une phrase facile à retenir est plus sûre qu’un mot avec des symboles.',
  repeat: 'Confirmez le mot de passe',
  mismatch: 'Les mots de passe ne correspondent pas.',
  creating: 'Création du compte…',
  submit: 'Créer le compte et se connecter',
  failed: 'Impossible de créer le compte',
} satisfies Translation<typeof source>;
