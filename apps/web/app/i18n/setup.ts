import type { Message, MessageTable } from '~/utils/i18n';

const es = {
  pageTitle: 'Configuración inicial · Personal Cloud',
  title: 'Crea la cuenta de propietario',
  lead: 'Es la cuenta con acceso total a tu nube. La contraseña no se puede recuperar por correo: guárdala en un lugar seguro.',
  code: 'Código de configuración',
  codeHelp: 'Código de un solo uso que da el servidor al instalarlo (válido 24 h). Demuestra que tienes acceso a la Raspberry Pi.',
  username: 'Nombre de usuario',
  usernameHelp: 'Letras, números, punto, guion y guion bajo.',
  password: 'Contraseña',
  passwordHelp: 'Al menos {n} caracteres. Una frase fácil de recordar es más segura que una palabra con símbolos.',
  repeat: 'Repite la contraseña',
  mismatch: 'Las contraseñas no coinciden.',
  creating: 'Creando la cuenta…',
  submit: 'Crear cuenta y entrar',
  failed: 'No se pudo crear la cuenta',
} satisfies MessageTable;

export default {
  es,
  en: {
    pageTitle: 'Initial setup · Personal Cloud',
    title: 'Create the owner account',
    lead: 'This account has full access to your cloud. The password can’t be recovered by email, so keep it somewhere safe.',
    code: 'Setup code',
    codeHelp: 'One-time code the server shows during installation (valid for 24 h). It proves you have access to the Raspberry Pi.',
    username: 'Username',
    usernameHelp: 'Letters, numbers, periods, hyphens and underscores.',
    password: 'Password',
    passwordHelp: 'At least {n} characters. An easy-to-remember phrase is safer than a word with symbols.',
    repeat: 'Confirm password',
    mismatch: 'Passwords don’t match.',
    creating: 'Creating account…',
    submit: 'Create account and sign in',
    failed: 'Couldn’t create the account',
  } satisfies Record<keyof typeof es, Message>,
};
