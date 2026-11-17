/**
 * Textos que redacta el servidor (en español): mensajes de error, avisos del disco, avisos de
 * nombres de archivo y detalles. En español se muestran tal cual; en inglés se traducen aquí por
 * texto exacto o por patrón (los que llevan datos variables). Si un texto no se reconoce, se
 * muestra el original: nunca un mensaje genérico que pueda decir algo distinto.
 */

/** Español exacto → inglés. */
export const EXACT: Record<string, string> = {
  // Errores de la API (AppError)
  'El contenido recibido no coincide con el SHA-256 declarado': 'The uploaded content doesn’t match the declared SHA-256',
  'El archivo cambió durante la copia': 'The file changed while it was being copied',
  'El contenido cambió durante la copia': 'The content changed while it was being copied',
  'El destino cambió durante la operación': 'The destination changed during the operation',
  'Esta llave de acceso ya está registrada': 'This passkey is already registered',
  'Hay un bloque en curso: vuelve a intentarlo': 'A chunk is still uploading. Try again.',
  'La cuenta de propietario ya existe': 'The owner account already exists',
  'La subida ya no admite datos': 'This upload no longer accepts data',
  'No puedes eliminar tu propia cuenta': 'You can’t delete your own account',
  'No se pudo encontrar un nombre libre': 'Couldn’t find an available name',
  'Ya existe un elemento con ese nombre': 'An item with that name already exists',
  'No se puede compartir la nube entera: elige un archivo o una carpeta': 'You can’t share the whole cloud: choose a file or a folder',
  'Ese enlace no existe': 'That link doesn’t exist',
  'Hay una copia de seguridad en curso: espera a que termine o cancélala': 'A backup is in progress: wait for it to finish or cancel it',
  'El reinicio desde la web no está instalado en este equipo': 'Restarting from the web isn’t installed on this device',
  'No se pudo programar la orden': 'The command couldn’t be scheduled',
  'La carpeta de red no está instalada en este equipo': 'The network folder isn’t installed on this device',
  'El código no es correcto o ha caducado. Pide uno nuevo en Ajustes de la nube.': 'The code is wrong or has expired. Get a new one in the cloud’s Settings.',
  'El límite de descargas solo se puede poner a un archivo': 'A download limit can only be set on a file',
  'Ya existe un usuario con ese nombre': 'A user with that name already exists',
  'Ya hay un bloque en curso para esta subida': 'A chunk is already uploading for this upload',
  'Ya hay una prueba de velocidad en curso': 'A speed test is already running',
  'El código de configuración no es válido o ha caducado': 'The setup code is invalid or has expired',
  'La contraseña actual no es correcta': 'The current password is incorrect',
  'La contraseña no es correcta': 'The password is incorrect',
  'Solo el propietario puede hacer esto': 'Only the owner can do this',
  // Copia de seguridad (ADR-0017)
  'Hay una copia en curso': 'A backup is in progress',
  'Ya hay una prueba de red en curso': 'A network test is already running',
  'La prueba de subida admite como mucho 32 MB por envío': 'The upload test accepts at most 32 MB per request',
  'Ese disco no está conectado': 'That disk isn’t connected',
  'El disco tiene que estar en exFAT o NTFS': 'The disk must be formatted as exFAT or NTFS',
  'La sincronización espera confirmación': 'The sync is waiting for confirmation',
  'Ya hay una copia en curso': 'A backup is already in progress',
  'No hay ningún disco de copia asignado': 'No backup disk has been assigned',
  'Hay una copia en curso: cancélala antes': 'A backup is in progress: cancel it first',
  'No se pudo expulsar el disco; vuelve a intentarlo': 'The disk couldn’t be ejected; try again',
  'WebAuthn: el dispositivo no verificó la identidad (biometría o PIN)':
    'WebAuthn: the device didn’t verify your identity (biometrics or PIN)',
  'WebAuthn: el reto pertenece a otra sesión': 'WebAuthn: the challenge belongs to another session',
  'WebAuthn: falta la presencia del usuario': 'WebAuthn: user presence is missing',
  'WebAuthn: la llave pertenece a otro sitio': 'WebAuthn: the passkey belongs to another site',
  'WebAuthn: operación desde otro origen': 'WebAuthn: operation from another origin',
  'WebAuthn: origen no permitido': 'WebAuthn: origin not allowed',
  'No queda espacio suficiente en el disco': 'There isn’t enough space left on the disk',
  'La prueba de velocidad no devolvió resultados': 'The speed test returned no results',
  'El nombre no puede empezar por un espacio': 'Names can’t start with a space',
  'Nombre reservado del sistema': 'This name is reserved by the system',
  'La ruta sale del volumen de datos': 'The path goes outside the data volume',
  'Los elementos deben estar en la carpeta indicada': 'The items must be in the specified folder',
  'Los enlaces simbólicos no están admitidos': 'Symbolic links aren’t supported',
  'No se puede copiar la carpeta raíz': 'The root folder can’t be copied',
  'No se puede copiar una carpeta dentro de sí misma': 'A folder can’t be copied into itself',
  'No se puede eliminar la carpeta raíz': 'The root folder can’t be deleted',
  'No se puede mover la carpeta raíz': 'The root folder can’t be moved',
  'No se puede mover una carpeta dentro de sí misma': 'A folder can’t be moved into itself',
  'No se puede renombrar la carpeta raíz': 'The root folder can’t be renamed',
  'Ruta demasiado profunda': 'The path is too deep',
  'Ruta no válida': 'Invalid path',
  'Ruta reservada del sistema': 'This path is reserved by the system',
  'El fichero temporal de la subida ya no existe: hay que empezar de nuevo':
    'The upload’s temporary file no longer exists. Start the upload again.',
  'La raíz de datos no está disponible': 'The data root isn’t available',
  'La subida no existe o ha caducado': 'The upload doesn’t exist or has expired',
  'Llave de acceso no encontrada': 'Passkey not found',
  'No es un archivo ni una carpeta': 'It’s not a file or a folder',
  'No es un archivo': 'It’s not a file',
  'No es una carpeta': 'It’s not a folder',
  'No está en la papelera': 'It’s not in the Trash',
  'No existe': 'It doesn’t exist',
  'Ruta no encontrada': 'Path not found',
  'Sesión no encontrada': 'Session not found',
  'Usuario no encontrado': 'User not found',
  'El fichero recibido no tiene el tamaño declarado': 'The received file doesn’t match the declared size',
  'El offset no coincide con el del servidor': 'The offset doesn’t match the server’s',
  'Faltan datos por recibir': 'Some data hasn’t been received yet',
  'El bloque supera el tamaño permitido o el tamaño declarado del archivo':
    'The chunk exceeds the allowed size or the file’s declared size',
  'Hay rutas demasiado largas para un ZIP': 'Some paths are too long for a ZIP',
  'El rango pedido no existe en el archivo': 'The requested range doesn’t exist in the file',
  'Demasiados intentos. Espera unos minutos y vuelve a probar.': 'Too many attempts. Wait a few minutes and try again.',
  'Ya hay otras reproducciones convertidas en curso. Ciérralas o espera un momento.':
    'Other converted playbacks are already in progress. Close them or wait a moment.',
  'Esta llave de acceso no está registrada en este servidor': 'This passkey isn’t registered on this server',
  'Esta llave de acceso parece duplicada: se ha bloqueado por seguridad':
    'This passkey appears to be duplicated and has been blocked for security',
  'Inicia sesión para continuar': 'Sign in to continue',
  'La llave de acceso no es válida': 'The passkey isn’t valid',
  'La solicitud ha caducado. Vuelve a intentarlo.': 'The request has expired. Try again.',
  'Usuario o contraseña incorrectos': 'Incorrect username or password',
  'El archivo está vacío': 'The file is empty',
  'El servidor no tiene LibreOffice instalado': 'LibreOffice isn’t installed on the server',
  'El servidor no tiene ffmpeg instalado': 'ffmpeg isn’t installed on the server',
  'Este archivo no tiene audio ni vídeo reproducible': 'This file has no playable audio or video',
  'Falta la herramienta fio en el servidor (pcloud-install-packages.sh)':
    'The fio tool is missing on the server (pcloud-install-packages.sh)',
  'No es un documento de oficina': 'It’s not an office document',
  'No es una imagen': 'It’s not an image',
  'No se pudo convertir esta imagen': 'Couldn’t convert this image',
  'No se pudo convertir este documento': 'Couldn’t convert this document',
  'No se pudo generar la vista previa': 'Couldn’t generate the preview',
  'No se reconoce el formato de este archivo': 'This file format isn’t recognized',
  'Sin vista previa para este tipo de archivo': 'No preview available for this file type',
  'CBOR demasiado anidado': 'CBOR nested too deeply',
  'CBOR truncado': 'Truncated CBOR',
  'CBOR: entero demasiado grande': 'CBOR: integer too large',
  'CBOR: lista demasiado larga': 'CBOR: array too long',
  'CBOR: longitud indefinida no admitida': 'CBOR: indefinite length not supported',
  'CBOR: mapa demasiado largo': 'CBOR: map too long',
  'CBOR: tipo no admitido': 'CBOR: unsupported type',
  'CBOR: valor simple no admitido': 'CBOR: unsupported simple value',
  'Las llaves de acceso necesitan abrir la aplicación por su nombre con HTTPS (por ejemplo https://nombre-del-servidor.local), no por la dirección IP.':
    'Passkeys require opening the app by its name over HTTPS (for example https://server-name.local), not by its IP address.',
  'No hay nada que descargar': 'There’s nothing to download',
  'WebAuthn: algoritmo de clave no admitido': 'WebAuthn: unsupported key algorithm',
  'WebAuthn: atestación no válida': 'WebAuthn: invalid attestation',
  'WebAuthn: clave pública no válida': 'WebAuthn: invalid public key',
  'WebAuthn: clientDataJSON no válido': 'WebAuthn: invalid clientDataJSON',
  'WebAuthn: credencial no válida': 'WebAuthn: invalid credential',
  'WebAuthn: credencial truncada': 'WebAuthn: truncated credential',
  'WebAuthn: curva no admitida': 'WebAuthn: unsupported curve',
  'WebAuthn: datos del autenticador demasiado cortos': 'WebAuthn: authenticator data too short',
  'WebAuthn: falta la credencial': 'WebAuthn: credential is missing',
  'WebAuthn: identificador de credencial incoherente': 'WebAuthn: inconsistent credential ID',
  'WebAuthn: tipo de operación incorrecto': 'WebAuthn: wrong operation type',

  // Errores genéricos del mapeo HTTP y resultados por elemento de las operaciones en lote
  'El disco ha dejado de responder durante la operación': 'The disk stopped responding during the operation',
  'El disco está lleno': 'The disk is full',
  'Petición no válida': 'Invalid request',
  'Petición demasiado grande': 'Request too large',
  'Error interno': 'Internal error',
  'No se pudo iniciar la conversión': 'Couldn’t start the conversion',
  'Sin permiso sobre este elemento': 'You don’t have permission for this item',
  'No se ha intentado: el disco dejó de estar disponible': 'Not attempted: the disk became unavailable',

  // Avisos del disco (VolumeIssue)
  'Error de E/S al acceder al volumen': 'I/O error while accessing the volume',
  'El servicio no tiene permisos sobre el volumen (revisar uid/gid del montaje)':
    'The service doesn’t have permissions on the volume (check the mount’s uid/gid)',
  'El sistema de archivos FUSE no responde (ENOTCONN)': 'The FUSE file system isn’t responding (ENOTCONN)',
  'No se pudo determinar el estado del volumen': 'Couldn’t determine the volume’s status',
  'El disco no responde: se han detenido las operaciones para protegerlo':
    'The disk isn’t responding. Operations have been stopped to protect it.',
  'No hay ningún volumen configurado (storage.expected_fs_uuid)': 'No volume is configured (storage.expected_fs_uuid)',
  'No se pudo leer la tabla de montajes': 'Couldn’t read the mount table',
  'El punto de montaje no es una ruta canónica (¿enlace simbólico?)': 'The mount point isn’t a canonical path (symbolic link?)',
  'El disco vuelve a responder: se comprueba que funcione estable antes de usarlo':
    'The disk is responding again. Checking that it’s stable before using it.',
  'El disco no responde: hay operaciones esperando sin avanzar': 'The disk isn’t responding. Some operations are stuck waiting.',
  'El montaje cambió durante la comprobación': 'The mount changed during the check',
  'Hay otro disco montado y el disco configurado no está conectado':
    'A different disk is mounted and the configured disk isn’t connected',
  'El disco configurado no está conectado (montaje obsoleto o desconexión)':
    'The configured disk isn’t connected (stale mount or disconnection)',
  'El disco montado no es el disco configurado': 'The mounted disk isn’t the configured disk',
  'Debe montarse el sistema de archivos completo, no un subdirectorio': 'The whole file system must be mounted, not a subdirectory',
  'El tipo de montaje no coincide con el configurado': 'The mount type doesn’t match the configured one',
  'El volumen se montó con "force" (posible NTFS sucio/hibernado): requiere chkdsk':
    'The volume was mounted with "force" (NTFS may be dirty or hibernated): chkdsk required',
  'El volumen está montado pero aún no se ha vinculado a esta instalación':
    'The volume is mounted but hasn’t been linked to this installation yet',
  'El marcador de volumen no es un fichero regular válido': 'The volume marker isn’t a valid regular file',
  'El marcador de volumen está dañado o tiene un formato desconocido': 'The volume marker is damaged or in an unknown format',
  'El volumen pertenece a otra instalación (marcador distinto)': 'The volume belongs to another installation (different marker)',
  'La raíz de datos no existe o no es un directorio real del volumen':
    'The data root doesn’t exist or isn’t a real directory on the volume',
  'El volumen está montado en solo lectura': 'The volume is mounted read-only',
  'El kernel rechaza escrituras en el volumen (EROFS)': 'The kernel is rejecting writes to the volume (EROFS)',

  // Avisos de nombres no portables (FsEntry.issue y motivo de INVALID_NAME)
  'Nombre vacío': 'Empty name',
  'Nombre reservado': 'Reserved name',
  'Contiene caracteres no válidos en Windows (\\ / : * ? " < > |)':
    'Contains characters that aren’t valid on Windows (\\ / : * ? " < > |)',
  'Termina en espacio o punto: no válido en Windows': 'Ends with a space or period, which isn’t valid on Windows',
  'Nombre reservado en Windows': 'Reserved name on Windows',
  'Nombre demasiado largo (más de 255 caracteres)': 'Name too long (more than 255 characters)',
  'Coincide con otro nombre salvo por mayúsculas o acentos': 'Matches another name except for capitalization or accents',
};

/** Mensajes con partes variables: patrón sobre el español → inglés. */
export const PATTERNS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  // Errores de la API (AppError)
  [/^La subida está en estado (.+)$/, (m) => `The upload is in state ${m[1] ?? ''}`],
  [/^Falta la cabecera (.+)$/, (m) => `The ${m[1] ?? ''} header is missing`],
  [
    /^La carpeta «(.+)» guarda las copias de tus ordenadores: no se puede borrar, mover ni renombrar mientras la carpeta de red esté activa$/,
    (m) => `The “${m[1] ?? ''}” folder holds your computers’ backups: it can’t be deleted, moved or renamed while the network folder is on`,
  ],
  [/^La prueba de velocidad falló: ([\s\S]*)$/, (m) => `The speed test failed: ${m[1] ?? ''}`],
  [
    /^«(.+)»: (.+)\. Renómbralo antes de copiar\.$/,
    (m) => `“${m[1] ?? ''}”: ${EXACT[m[2] ?? ''] ?? m[2] ?? ''}. Rename it before copying.`,
  ],
  [
    /^Contiene un enlace o elemento especial que no se puede copiar: (.+)$/,
    (m) => `Contains a link or special item that can’t be copied: ${m[1] ?? ''}`,
  ],
  [/^Demasiados elementos para copiar de una vez \(máximo (.+)\)$/, (m) => `Too many items to copy at once (maximum ${m[1] ?? ''})`],
  [/^Demasiados elementos para un ZIP \(máximo (.+)\)$/, (m) => `Too many items for a ZIP (maximum ${m[1] ?? ''})`],
  [/^El contenido debe enviarse como (.+)$/, (m) => `Content must be sent as ${m[1] ?? ''}`],
  [/^WebAuthn: falta (.+)$/, (m) => `WebAuthn: ${m[1] ?? ''} is missing`],

  // Disco no disponible (StorageUnavailableError)
  [
    /^El volumen cambió durante la operación \(generación (.+) → (.+)\)$/,
    (m) => `The volume changed during the operation (generation ${m[1] ?? ''} → ${m[2] ?? ''})`,
  ],
  [
    /^El disco configurado no está disponible para (escritura|lectura|vinculación) \(estado (.+)\)$/,
    (m) => {
      const what = m[1] === 'escritura' ? 'writing' : m[1] === 'lectura' ? 'reading' : 'linking';
      return `The configured disk isn’t available for ${what} (state ${m[2] ?? ''})`;
    },
  ],

  // Avisos del disco (VolumeIssue)
  [/^El directorio de montaje (.+) no existe$/, (m) => `The mount directory ${m[1] ?? ''} doesn’t exist`],
  [/^No hay ningún disco montado en (.+)$/, (m) => `No disk is mounted at ${m[1] ?? ''}`],
  [/^Hay varios montajes no apilados en (.+)$/, (m) => `There are several non-stacked mounts at ${m[1] ?? ''}`],
  [
    /^(.+) pertenece al sistema de archivos del sistema, el HDD no está montado$/,
    (m) => `${m[1] ?? ''} belongs to the system file system. The HDD isn’t mounted.`,
  ],
  [/^Falta (.+) en el volumen$/, (m) => `${m[1] ?? ''} is missing on the volume`],
  [/^(.+) no es un directorio real del volumen$/, (m) => `${m[1] ?? ''} isn’t a real directory on the volume`],
];

/** Traducción al idioma activo de un texto del servidor (o el original si no se conoce). */
export function serverText(message: string): string {
  if (locale.value === 'es' || message === '') return message;
  const exact = EXACT[message];
  if (exact !== undefined) return exact;
  for (const [pattern, render] of PATTERNS) {
    const match = message.match(pattern);
    if (match !== null) return render(match);
  }
  return message;
}

/** ¿Hay traducción para este texto? (para decidir si usar un mensaje por código en su lugar). */
export function hasServerText(message: string): boolean {
  return message in EXACT || PATTERNS.some(([pattern]) => pattern.test(message));
}
