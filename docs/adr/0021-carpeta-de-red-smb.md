# ADR-0021: Carpeta de red (SMB) para copias desde los ordenadores de casa

Estado: Aceptado (2026-11-17)

## Contexto

El propietario quiere que los ordenadores de casa hagan su copia de seguridad en la nube con una
aplicación de escritorio (DEV Backup Studio). Esa aplicación copia en una ruta del sistema de
archivos: necesita escribir, renombrar y releer archivos. Hacerlo por la API HTTP exigiría tokens de
API, un protocolo de sincronización nuevo y reescribir el motor de la aplicación. Windows y macOS
ya saben escribir en una carpeta compartida por SMB.

La SPEC (§ seguridad) dice: «No habilitar SMB, FTP ni WebDAV por defecto. Si aparecen en el futuro,
serán módulos opcionales y sometidos a auditoría». Este ADR es esa auditoría.

Riesgos que hay que cerrar:

- **Mandato principal:** Samba escribe sin pasar por el StorageGuardian. No puede escribir nunca en
  la tarjeta del sistema ni en un disco equivocado.
- **Exposición:** un servicio más escuchando en la red.
- **Permisos:** el disco (exFAT/NTFS) está montado con `uid`/`gid` de `pcloud` y `dmask=0077`; lo que
  escriba Samba tiene que poder leerlo y gestionarlo la web.

## Decisión

1. **Opcional y aparte.** `pcloud-install-smb.sh` (dry-run por defecto, `--execute`, `--remove`).
   `install.sh` no lo ejecuta ni lo pregunta.
2. **Una sola carpeta.** Se comparte `<raíz de datos>/Copias`. No se comparte la raíz de datos, ni
   `.pcloud/`, ni el disco entero. En la web aparece como una carpeta más.
3. **Disco ausente = conexión rechazada.** `root preexec` ejecuta `pcloud-smb-check.sh` antes de cada
   conexión. Solo la acepta si:
   - `/srv/pcloud` es un punto de montaje;
   - `/api/v1/system/health` dice `volumeState: READY`;
   - la carpeta existe.

   Si el disco desaparece con una sesión abierta, la ruta deja de existir y `/srv/pcloud` es
   `root 0555 + inmutable` (ADR-0005): las escrituras fallan y no caen en la microSD.
4. **Usuario propio.** Se conecta `pcloud-smb`, un usuario de sistema sin shell ni carpeta personal.
   Su contraseña de Samba es aleatoria (24 caracteres), se muestra una vez y no se guarda en ningún
   fichero. Todo se escribe con `force user = pcloud`, como lo que sube la web.
5. **Superficie mínima:**
   - Solo SMB3 en el puerto 445. Sin NetBIOS (nmbd apagado), sin SMB1, sin invitados ni sesiones
     anónimas, sin impresoras.
   - `hosts allow` solo con rangos privados, Tailscale (`100.64.0.0/10`) y loopback.
   - Cifrado SMB3 si el cliente lo admite (`server smb encrypt = desired`).
6. **Sin atributos extendidos.** `ea support = no`, `store dos attributes = no` y sin mapear atributos
   DOS a permisos: exFAT y NTFS montados con permisos fijos no los guardan.
7. **Configuración generada.** El script escribe `/etc/samba/smb.conf` desde
   `deploy/linux/samba/smb.conf.tmpl`, lo valida con `testparm` antes de ponerlo en su sitio y guarda
   el original en `smb.conf.pcloud-original`. `--remove` lo restaura.

## Consecuencias

- La copia de seguridad en disco externo (ADR-0017) incluye `Copias`: lo de los ordenadores queda
  en dos discos.
- Lo escrito por SMB no pasa por el registro de auditoría, el staging ni la papelera de la nube. Las
  versiones y la verificación las pone el cliente (DEV Backup Studio guarda `.devbackup/versiones` y
  comprueba cada copia con SHA-256).
- La carpeta no aparece en «Red» de Windows (no hay NetBIOS ni WS-Discovery): se escribe la
  dirección `\\<host>.local\Copias` a mano. En macOS: `smb://<host>.local/Copias`.
- En una Raspberry Pi 4 (sin instrucciones AES) el cifrado SMB3 limita la velocidad a unas decenas
  de MB/s. En la red de casa es aceptable para copias incrementales.
- Desde fuera de casa funciona por Tailscale (`\\<host>\Copias`), nunca abierto a Internet.

## Alternativas descartadas

- **Destino «PCS» nativo por la API HTTP:** tokens de API, listado completo con fechas, subida que
  conserve la fecha, mover sin resubir y hash en el servidor. Es más limpio, pero es de 3 a 5 veces
  más trabajo en los dos proyectos. Se puede hacer más adelante sin cambiar nada de este ADR.
- **WebDAV:** el cliente de Windows es lento, limita los archivos a 50 MB por defecto y no conserva
  la fecha de modificación.
- **Compartir la raíz de datos:** un error en el cliente podría borrar la nube entera.
- **Contraseña elegida por la persona en `smbpasswd`:** obliga a usar la terminal. La aleatoria se
  muestra una vez, como el código de configuración inicial.
