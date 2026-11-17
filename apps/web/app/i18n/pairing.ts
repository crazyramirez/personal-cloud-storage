import type { Message, MessageTable } from '~/utils/i18n';

const es = {
  title: 'Copias de tus ordenadores',
  intro: 'Tus ordenadores pueden guardar su copia de seguridad en la nube con DEV Backup Studio. Se conectan con un código, sin escribir contraseñas.',
  connect: 'Conectar un ordenador',
  newCode: 'Otro código',
  cancel: 'Anular',
  codeLabel: 'Código para conectar',
  step1: 'En el ordenador, abre DEV Backup Studio.',
  step2: 'Pulsa «Conectar con mi nube».',
  step3: 'Escribe este código.',
  expires: ({ min }) => `Caduca en ${min} min y sirve una sola vez.`,
  expired: 'El código ha caducado.',
  where: ({ host, share }) => `Las copias se guardan en la carpeta «${share}» de la nube (\\\\${host}\\${share}).`,
  unavailable: 'La carpeta de red no está instalada en este equipo. Para activarla, ejecuta en el servidor: sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-install-smb.sh --execute',
  failed: 'No se pudo crear el código',
  copied: 'Código copiado',
  copy: 'Copiar código',
} satisfies MessageTable;

export default {
  es,
  en: {
    title: 'Backups of your computers',
    intro: 'Your computers can keep their backup in the cloud with DEV Backup Studio. They connect with a code, no passwords to type.',
    connect: 'Connect a computer',
    newCode: 'New code',
    cancel: 'Cancel',
    codeLabel: 'Connection code',
    step1: 'On the computer, open DEV Backup Studio.',
    step2: 'Click “Connect to my cloud”.',
    step3: 'Type this code.',
    expires: ({ min }) => `Expires in ${min} min and works only once.`,
    expired: 'The code has expired.',
    where: ({ host, share }) => `Backups are kept in the cloud folder “${share}” (\\\\${host}\\${share}).`,
    unavailable: 'The network folder is not installed on this device. To turn it on, run on the server: sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-install-smb.sh --execute',
    failed: 'Could not create the code',
    copied: 'Code copied',
    copy: 'Copy code',
  } satisfies Record<keyof typeof es, Message>,
};
