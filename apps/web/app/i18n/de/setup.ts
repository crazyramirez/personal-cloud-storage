import type { Translation } from '~/utils/i18n';
import type source from '../setup';

export default {
  pageTitle: 'Ersteinrichtung · Personal Cloud',
  title: 'Inhaberkonto erstellen',
  lead: 'Dieses Konto hat vollen Zugriff auf Ihre Cloud. Das Passwort kann nicht per E-Mail wiederhergestellt werden: Bewahren Sie es sicher auf.',
  code: 'Einrichtungscode',
  codeHelp: 'Einmaliger Code, den der Server bei der Installation ausgibt (24 h gültig). Er belegt, dass Sie Zugriff auf den Raspberry Pi haben.',
  username: 'Nutzername',
  usernameHelp: 'Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich.',
  password: 'Passwort',
  passwordHelp: 'Mindestens {n} Zeichen. Ein leicht zu merkender Satz ist sicherer als ein Wort mit Sonderzeichen.',
  repeat: 'Passwort wiederholen',
  mismatch: 'Die Passwörter stimmen nicht überein.',
  creating: 'Konto wird erstellt…',
  submit: 'Konto erstellen und anmelden',
  failed: 'Konto konnte nicht erstellt werden',
} satisfies Translation<typeof source>;
