# Operación del servidor

Guía para instalar y operar Personal Cloud Storage en tu propio servidor. En los ejemplos:

| Marcador | Significado |
|---|---|
| `<host>` | nombre del equipo (`hostname`); por mDNS se anuncia como `<host>.local` |
| `<ip>` | IPv4 del servidor en la LAN (conviene reservarla en el router) |
| `<UUID>` | UUID del sistema de archivos del HDD (`pcloud-volume-check.sh --list`) |
| `<SERIE_ATA>` | número de serie del disco (lo muestra `pcloud-volume-check.sh`) |
| `<tailnet>` | nombre de tu red de Tailscale (`<host>.<tailnet>.ts.net`) |

Plataformas soportadas: ver [Requisitos en el README](../README.md#requisitos). Hardware de referencia (donde se han hecho todas las pruebas físicas): Raspberry Pi 4B 8 GB con Raspberry Pi OS Lite 64-bit (Debian 13 trixie) y un HDD USB de 2,5" de 5 TB en exFAT.

## 1. Qué se instala y dónde

| Componente | Ubicación / valor | Lo gestiona |
|---|---|---|
| Node.js 26 LTS | `/opt/nodejs/node-<versión>-linux-<arch>` (enlace `/opt/nodejs/current`, binarios en `/usr/local/bin`) | `pcloud-install-node.sh` (tarball oficial + SHA-256) |
| pnpm 12 | `/usr/local/bin/pnpm` | `pcloud-install-node.sh` (sin scripts de instalación) |
| Paquetes | smartmontools, hdparm, iperf3, fio | `pcloud-install-packages.sh` (`smartd` e `iperf3` desactivados) |
| Usuario de servicio | `pcloud` (cuenta de sistema, sin login) | `pcloud-bootstrap.sh` |
| Configuración | `/etc/pcloud/config.yaml` (root:pcloud 0640); plantilla en [deploy/config/config.example.yaml](../deploy/config/config.example.yaml) | `pcloud-bootstrap.sh`, `pcloud-onboard-volume.sh` |
| Estado interno | `/var/lib/pcloud/{database,secrets,locks,snapshots-db}` (pcloud 0700), **en el disco del sistema, nunca en el HDD** | `pcloud-bootstrap.sh` |
| Aplicación | `/opt/pcloud/releases/<release>`, enlace `/opt/pcloud/current` | `pcloud-deploy-release.sh` |
| Comando de estado | `/usr/local/bin/pcloud-volume-status` (se ejecuta como `pcloud`) | `pcloud-deploy-release.sh` |
| Servidor API | `pcloud.service` (systemd, usuario `pcloud`, solo `127.0.0.1:3000`, sin red fuera de loopback) | `pcloud-install-service.sh` |
| Base de datos | `/var/lib/pcloud/database/pcloud.sqlite` (WAL); copia previa a cada migración en `snapshots-db/` | el servidor |
| HTTPS (LAN) | Caddy: `/etc/caddy/Caddyfile` para `<host>.local`, `<host>` y `<ip>`; CA interna en `/var/lib/caddy`; raíz pública en `https://<host>.local/pcloud-ca.crt` ([ADR-0011](adr/0011-https-lan-caddy.md)) | `pcloud-install-caddy.sh` |
| Mountpoint | `/srv/pcloud` root:root 0555 **+i** (inmutable sin disco) | `pcloud-mountpoint-guard.sh` |
| Montaje del HDD | `/etc/fstab`: `UUID=<UUID> /srv/pcloud exfat rw,nofail,noatime,nodev,nosuid,noexec,uid=<pcloud>,gid=<pcloud>,fmask=0177,dmask=0077,x-systemd.device-timeout=15s,iocharset=utf8,errors=remount-ro 0 0` | `pcloud-fstab-entry.sh` (deja copia `/etc/fstab.pcloud-<fecha>`) |
| Volumen vinculado | `.pcloud/{staging,trash,versions,volume-id}` + `data/` en el HDD | `pcloud-onboard-volume.sh` |
| Vaciado de caché del HDD | `/etc/udev/rules.d/70-pcloud-disk-write-cache.rules` (por número de serie) | `pcloud-disk-write-cache.sh` ([ADR-0009](adr/0009-durabilidad-cache-y-directorios.md)) |
| SSH | Solo clave; sin contraseña ni root; `/etc/ssh/sshd_config.d/10-pcloud.conf` | `pcloud-ssh-hardening.sh` |
| Wi-Fi | Ahorro de energía desactivado (NetworkManager) | `pcloud-system-tuning.sh` |

## 2. Acceso SSH

- Usa siempre clave: `ssh-keygen -t ed25519` en tu ordenador y copia la pública al servidor (`ssh-copy-id <usuario>@<host>.local`).
- Ancla la huella del servidor en `known_hosts` la primera vez y compruébala en la consola local (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).
- `pcloud-ssh-hardening.sh apply --execute` desactiva la contraseña y root, con **reversión automática** si no confirmas desde una sesión nueva. En consola física la contraseña sigue funcionando y `sudo` la sigue pidiendo.
- Estado y reversión: `sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-ssh-hardening.sh status|revert`.

## 3. Instalación desde cero (orden)

**Lo normal es usar el instalador en un paso**, que ejecuta todo lo de abajo en orden, elige el disco contigo y muestra la dirección y el código de configuración:

```bash
curl -fsSL https://raw.githubusercontent.com/crazyramirez/personal-cloud-storage/main/install.sh | sudo bash
```

Opciones y detalles: [README → Instalación](../README.md#instalación). Lo que sigue es el mismo proceso a mano, útil para entenderlo, depurarlo o adaptarlo.

Requisitos previos: Linux de 64 bits basado en Debian (Debian, Ubuntu, Raspberry Pi OS), systemd, `avahi-daemon` para `<host>.local` y el HDD **ya formateado** en exFAT o NTFS (estos scripts nunca formatean).

Copia `deploy/` al servidor y ejecuta, en este orden (todos son dry-run sin `--execute` e idempotentes):

```bash
D=~/pcloud-setup/deploy/linux/setup
sudo bash $D/pcloud-install-node.sh
sudo bash $D/pcloud-install-packages.sh --execute --upgrade
sudo bash $D/pcloud-bootstrap.sh --execute
sudo bash $D/pcloud-mountpoint-guard.sh apply --execute
sudo bash $D/pcloud-system-tuning.sh --execute
# En el ordenador de desarrollo: bash deploy/dev/pack-release.sh y copia el paquete (§4). Luego:
sudo bash $D/pcloud-deploy-release.sh install /tmp/pcloud-AAAAMMDDTHHMMSSZ.tar.gz
sudo bash $D/pcloud-install-viewers.sh --execute           # opcional: ffmpeg + LibreOffice sin interfaz (visores)
sudo bash $D/pcloud-install-service.sh --execute           # pcloud.service (arranca aunque no haya disco)
sudo bash $D/pcloud-install-caddy.sh --execute             # HTTPS en la LAN; repetir si cambia la IP
sudo bash $D/pcloud-ssh-hardening.sh apply --execute      # tras instalar una clave; luego 'confirm' desde una sesión nueva
# Disco
sudo bash $D/../diagnostics/pcloud-volume-check.sh --list  # localizar <UUID> y <SERIE_ATA>
sudo bash $D/pcloud-fstab-entry.sh --uuid <UUID> --execute --mount
sudo bash $D/pcloud-disk-write-cache.sh --serial <SERIE_ATA> --execute
sudo bash $D/pcloud-onboard-volume.sh --uuid <UUID> --execute
```

## 4. Desplegar, consultar y revertir

```bash
# Ordenador de desarrollo
bash deploy/dev/pack-release.sh                       # → .releases/pcloud-AAAAMMDDTHHMMSSZ.tar.gz
scp .releases/pcloud-*.tar.gz <usuario>@<host>.local:/tmp/

# Servidor
sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-deploy-release.sh install /tmp/pcloud-AAAAMMDDTHHMMSSZ.tar.gz
bash /opt/pcloud/current/deploy/linux/setup/pcloud-deploy-release.sh status
sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-deploy-release.sh rollback
sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-deploy-release.sh activate pcloud-AAAAMMDDTHHMMSSZ
```

`pack-release.sh` compila la web en el ordenador de desarrollo (el servidor no compila nada) y la incluye en el paquete.

`install` verifica el `manifest.sha256` y rechaza rutas `..` antes de extraer. Instala dependencias sin scripts, **ejecuta los tests en el servidor como `pcloud`** y solo si pasan cambia `/opt/pcloud/current` de forma atómica. Después reinicia `pcloud.service` y espera a que la API responda **con la release nueva**; si no responde en 30 s, vuelve sola a la anterior. Conserva las 5 releases más recientes. `rollback` y `activate` también reinician el servicio y comprueban la respuesta.

Caddy sirve la web desde `/opt/pcloud/current`, así que el cambio de release la actualiza sin reiniciar Caddy.

## 4 bis. Acceso a la web y primera configuración

1. Abrir `https://<host>.local/` (o `https://<ip>/`). La primera vez el navegador avisa del certificado: la CA es propia.
2. **Recomendado:** instalar la CA en cada dispositivo. Descárgala de `https://<host>.local/pcloud-ca.crt` y **comprueba la huella** SHA-256 antes de confiar en ella. La huella real se obtiene en el servidor:
   ```bash
   sudo openssl x509 -in /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt -noout -fingerprint -sha256
   ```
   - Windows: doble clic → *Instalar certificado* → *Usuario actual* → *Entidades de certificación raíz de confianza*.
   - Android: *Ajustes → Seguridad → Cifrado y credenciales → Instalar certificado → Certificado de CA*.
   - iPhone: abrir el enlace en Safari → *Ajustes → Perfil descargado → Instalar*, y después *General → Información → Ajustes de confianza de certificados*.
3. Crear la cuenta de propietario con el **código de configuración de un solo uso** (24 h). Aparece en el registro al arrancar sin propietario:
   ```bash
   sudo journalctl -u pcloud -b | grep -o 'Código de un solo uso.*'
   # o uno nuevo:
   sudo runuser -u pcloud -- node /opt/pcloud/current/apps/server/src/cli/admin.ts setup-token
   ```
4. Cuentas adicionales o rescate (la contraseña se lee de stdin y nunca va en argumentos):
   ```bash
   sudo runuser -u pcloud -- node /opt/pcloud/current/apps/server/src/cli/admin.ts user-list
   sudo runuser -u pcloud -- node /opt/pcloud/current/apps/server/src/cli/admin.ts user-add NOMBRE --role user
   ```

Las llaves de acceso (passkeys) solo funcionan abriendo la app **por nombre** con HTTPS (`https://<host>.local`), no por IP.

Estado del servicio: `systemctl status pcloud caddy`, `journalctl -u pcloud -f`, `curl -s http://127.0.0.1:3000/api/v1/system/health` (en el servidor). El servidor no registra cada petición (protege la tarjeta o disco del sistema y no deja nombres de fichero en el registro); las acciones relevantes van a `audit_log` en SQLite.

## 4 ter. Acceso desde Internet (Tailscale, opcional)

- Instalar/reautorizar: `sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-install-tailscale.sh --execute [--hostname <host>]` (enlace de autorización en la salida).
- En la consola de Tailscale, activar *MagicDNS* y *HTTPS Certificates*. Después: `sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-install-caddy.sh --execute` (añade el sitio `*.ts.net`).
- URL fuera de casa: `https://<host>.<tailnet>.ts.net/` (certificado válido de Let's Encrypt emitido por Tailscale). Requiere la app Tailscale con la misma cuenta en el dispositivo.
- Nunca `tailscale funnel`/`serve`: solo dispositivos de la cuenta ([ADR-0016](adr/0016-acceso-remoto-tailscale.md)).
- Comprobar: `tailscale status`; `curl -sS -o /dev/null -w '%{http_code}\n' https://<host>.<tailnet>.ts.net/` → 200.
- Cortar el acceso remoto: `sudo tailscale down` (la LAN sigue igual).

## 5. Comprobaciones rutinarias

`pcloud-volume-status` se ejecuta siempre como el usuario `pcloud`, para evaluar sus permisos reales: si lo lanzas con tu usuario, `sudo` te pedirá la contraseña.

```bash
pcloud-volume-status                     # veredicto del guardián (exit 0 = READY)
pcloud-volume-status --watch 1           # vigilar transiciones
bash /opt/pcloud/current/deploy/linux/setup/pcloud-mountpoint-guard.sh check
cat /sys/block/sda/queue/write_cache     # debe decir "write back"
vcgencmd get_throttled                   # solo Raspberry Pi: 0x0 = sin subtensión desde el arranque
journalctl -k -b | grep -iE 'usb|exfat|ntfs|i/o error|reset|not properly unmounted'
```

## 6. Runbook: tras una desconexión o un corte de corriente

Comportamiento medido (F0, ver §8): el guardián bloquea las mutaciones en < 0,5 s y systemd desmonta solo al desaparecer el dispositivo, pero **no vuelve a montar solo al reconectar**.

1. Reconectar el disco (en la Raspberry Pi, puerto USB 3 azul). Comprobar `ls -l /dev/disk/by-uuid/<UUID>`.
2. Si `/srv/pcloud` sigue montado (montaje obsoleto): `sudo systemctl stop srv-pcloud.mount`.
3. **Comprobación de solo lectura:** `sudo fsck.exfat -n /dev/disk/by-uuid/<UUID>` (NTFS: `sudo ntfsfix -n`).
   - Limpio → `sudo systemctl start srv-pcloud.mount` → `pcloud-volume-status` debe dar READY.
   - Con errores → **no montar en escritura**. Montar en solo lectura para revisar, y reparar solo con una decisión explícita (`fsck.exfat -p`, o `-y` como último recurso) y, si hay datos únicos, tras copiarlos.
4. El flag VolumeDirty de exFAT queda activo aunque `fsck` esté limpio, porque Linux no lo borra si estaba activo al montar. Se limpia con `fsck.exfat -p` sobre el volumen desmontado, tras un `-n` limpio. Es una reparación: hazla solo a sabiendas.
5. En Raspberry Pi, revisar `vcgencmd get_throttled`: un bit de subtensión apunta a la alimentación.

## 6 bis. Runbook: «El disco no responde» (IO_STALLED / IO_TIMEOUT)

La interfaz muestra «El disco no responde» y la API devuelve `503` con `IO_STALLED` o `IO_TIMEOUT` ([ADR-0013](adr/0013-disco-que-no-responde.md)). Todo lo que ya estaba confirmado sigue en el disco; lo que no se confirmó, el cliente lo reenviará.

1. Esperar 1-2 minutos: un disco SMR muy ocupado puede recuperarse solo.
2. Comprobar el kernel: `journalctl -k -n 30 | grep -E "sd[a-z]|I/O error|timing out"`. Un *«timing out command, waited 180s»* repetido indica que no se recuperará solo.
3. **Reconectar físicamente:** desconectar el USB del disco, esperar 10 s y volver a conectarlo.
4. Seguir el runbook §6: `fsck` de solo lectura → montar si está limpio → `pcloud-volume-status`.
5. Si los procesos de `pcloud` quedaron en estado D, reiniciar el servicio después de reconectar (`systemctl restart pcloud`). Si no termina, reiniciar el servidor.
6. Causa más probable: **alimentación**. Un HDD alimentado solo por USB sufre con los picos de consumo (arranque del motor y CPU al máximo). Solución: fuente de alimentación adecuada para el servidor y hub USB con alimentación propia (o caja con fuente) para el disco.

## 7. Runbook: cambiar de disco

1. Desmontar (`sudo systemctl stop srv-pcloud.mount`) y desconectar el disco antiguo.
2. Desvincular de forma explícita: editar `/etc/pcloud/config.yaml` (`expected_fs_uuid` y `volume_marker` a `null`) y retirar la línea de `/etc/fstab` (hay copia `fstab.pcloud-*`). El binding se niega a sustituir un volumen vinculado en silencio.
3. Con el disco nuevo: `pcloud-volume-check.sh --list/--uuid` → `pcloud-fstab-entry.sh` → `pcloud-disk-write-cache.sh --serial <nueva serie>` (la regla udev va por número de serie) → `pcloud-onboard-volume.sh`.

## 8. Resultados de validación en el hardware de referencia (2026-11)

Raspberry Pi 4B 8 GB, HDD USB de 2,5" SMR de 5 TB en exFAT.

| Prueba | Resultado |
|---|---|
| Tests automáticos en el servidor como `pcloud` (incluye integración con el kernel) | ✅ todos en cada release |
| Guardián con dispositivos reales (UUID → dispositivo → major:minor) | ✅ |
| Laboratorio F0 con exFAT real en loop (14 escenarios) | ✅ 14/14 |
| Ni `pcloud` ni root pueden escribir en `/srv/pcloud` sin disco | ✅ |
| Ciclo de releases (`install`/`rollback`/`activate`, paquetes con `..` rechazados) | ✅ |
| Vinculación (onboarding + binding) e idempotencia | ✅ |
| **F0 físico, ronda 1** (desenchufar durante la escritura) | Detección en 0,28 s, 0 escrituras en la microSD, 13/13 ficheros sincronizados íntegros. **Encontró 2 fallos de durabilidad** ([ADR-0009](adr/0009-durabilidad-cache-y-directorios.md)) |
| **F0 físico, ronda 2** (con las correcciones) | ✅ 43/43 íntegros, 0 corruptos, 0 ausentes, 0 renombrados perdidos; regla de caché reaplicada sola al reconectar |
| Coste de un `fsync` real (fio, 64 KiB + fsync) | ~60 ms por vaciado (16 IOPS): no hacer fsync por chunk |
| Reinicio sin HDD y **con HDD** | ✅ arranque en 26-27 s; montaje automático; caché `write back`; READY |
| `pcloud.service`: desmontar y montar el HDD con el servicio en marcha | ✅ UNAVAILABLE → READY sin reiniciar el proceso (el montaje se propaga a su namespace) |
| HTTPS de extremo a extremo desde la LAN (certificado verificado con la CA interna) | ✅ web 200, API 200, HTTP → HTTPS 308, `Host` desconocido no llega a la API, puerto 3000 cerrado a la LAN |
| Flujo real por HTTPS | ✅ login (cookie `HttpOnly; Secure; SameSite=Strict`), carpeta, subida de 20 MiB en 3 bloques, SHA-256 idéntico al descargar, Range 206, sin CSRF 403, logout 401 |
| Rechazo `409 OFFSET_MISMATCH` a través de Caddy | ✅ 20/20 ([ADR-0010](adr/0010-protocolo-subida-reanudable.md)) |
| Velocidad por Wi-Fi (sin optimizar) | subida 4,0 MB/s (incluye `fsync` y TLS), descarga 11,5 MB/s |
| Memoria en reposo | Node ~111 MB RSS, Caddy ~42 MB |
| Disco sin respuesta bajo carga (CPU al máximo + fsync) con alimentación insuficiente | ❌ → corregido en el software: el guardián lo detecta (IO_STALLED) y bloquea las operaciones ([ADR-0013](adr/0013-disco-que-no-responde.md)). La causa era la alimentación: usa una fuente adecuada. |

## 8 bis. Copia de seguridad en disco externo

Diseño: [ADR-0017](adr/0017-copia-de-seguridad-disco-externo.md). Lo prepara el instalador (`pcloud-install-backup.sh --execute`): buzón `/var/lib/pcloud/backup-agent/inbox`, punto de montaje protegido `/srv/pcloud-backup` y `pcloud-backup-agent.{path,service}`.

- **Uso:** conectar un disco USB en exFAT o NTFS → la web ofrece asignarlo (escribe `.pcloud-backup/backup-id`; no borra nada) → «Sincronizar ahora». Con «Sincronizar automáticamente», conectar basta. Al terminar se desmonta solo.
- **En el disco de copia:** `Personal Cloud Storage/` (espejo de la nube), `.pcloud-backup/archivo/<fecha>/` (lo borrado o sustituido, caduca a los 90 días por defecto) y `.pcloud-backup/informes/<fecha>.json`.
- **Restaurar:** conectar el disco a cualquier PC y copiar desde `Personal Cloud Storage/` (o desde el archivo, por fecha).
- **Estado:** `systemctl status pcloud-backup-agent.path`, `journalctl -u pcloud-backup-agent -n 30`, `findmnt /srv/pcloud-backup`.
- **Desmontar a mano** (si la web no puede): `sudo umount /srv/pcloud-backup`. Comprobar la protección: `bash /opt/pcloud/current/deploy/linux/setup/pcloud-mountpoint-guard.sh check --mountpoint /srv/pcloud-backup`.
- **Alimentación:** en la Raspberry Pi, el disco de copia con fuente propia o en un hub alimentado.

## 8 ter. Enlaces para compartir con invitados

Ver [ADR-0018](adr/0018-enlaces-para-invitados.md) y [ADR-0019](adr/0019-nodo-tailscale-dedicado-enlaces.md). En Archivos, el propietario abre el menú de un archivo o carpeta, elige «Compartir enlace…» y envía el enlace.

- **Nodo dedicado:** Funnel va en un segundo `tailscaled` (`pcloud-share-tailscaled.service`, modo userspace, nombre `<host>-compartir`), nunca en el de la app. Los enlaces son `https://<host>-compartir.<tailnet>.ts.net/s/…`.
- **Requisitos (una vez):**
  - Tailscale instalado en la Pi (§4 ter) y «HTTPS Certificates» activado.
  - La primera vez que se crea un enlace, la app muestra dos pasos: «Conectar en Tailscale» (alta del nodo `<host>-compartir`) y, si hace falta, «Permitir en Tailscale» (Funnel).
  - En la consola de Tailscale, desactiva la caducidad de la clave de `<host>-compartir`.
- **Instalación:** `sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-install-share.sh --execute` (lo hace `install.sh`). Después, `sudo systemctl restart pcloud.service` para que abra el socket.
- **Comprobar:** `tailscale --socket=/run/pcloud-share-ts/tailscaled.sock funnel status`. Sin enlaces activos debe salir vacío. `tailscale funnel status` (nodo principal) debe salir SIEMPRE vacío.
- **Apagar todo ya:**
  - Retira los enlaces en Ajustes → Enlaces compartidos, o ejecuta `sudo tailscale --socket=/run/pcloud-share-ts/tailscaled.sock funnel --https=443 off`; se vuelve a encender si queda algún enlace activo.
  - Para quitar la función: `pcloud-install-share.sh --remove --execute`.
- **Registros:** `journalctl -u pcloud-share-agent -u pcloud-share-tailscaled --no-pager -n 40`.
- **Vista previa en los chats:**
  - Las páginas llevan Open Graph: `og:image` es `/og-image.jpg`, de 1200×630.
  - `robots.txt` deja entrar solo a los bots de vista previa (WhatsApp, Telegram…), no a los buscadores.
  - Si el enlace tiene contraseña, la vista previa no muestra el nombre.

## 8 quater. Reiniciar y apagar desde Ajustes

Ver [ADR-0020](adr/0020-reiniciar-apagar-desde-la-web.md). Ajustes → «Reiniciar o apagar» (solo el propietario).

- **Instalación:** `sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-install-power.sh --execute` (lo hace `install.sh`).
- **Registro:** `journalctl -u pcloud-power-agent --no-pager -n 20`.
- **Apagar:** la Raspberry Pi no tiene botón; para encenderla, desconecta y vuelve a conectar la alimentación.

## 8 quinquies. Carpeta de red para copias de los ordenadores (SMB, opcional)

Ver [ADR-0021](adr/0021-carpeta-de-red-smb.md), [ADR-0022](adr/0022-emparejar-ordenadores-con-codigo.md), [ADR-0023](adr/0023-carpeta-dev-backup-studio.md) y [ADR-0024](adr/0024-recientes-de-la-carpeta-de-red.md). Comparte por SMB solo la carpeta `DEV_Backup_Studio` de la nube para que los ordenadores de casa hagan su copia de seguridad en ella (por ejemplo con DEV Backup Studio). `install.sh` no la activa.

- **Activar:** con el disco conectado y la web funcionando, `sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-install-smb.sh --execute`. Guarda la credencial en `/etc/pcloud/smb.json` (root:pcloud 0640) y anuncia la nube en la red (`/etc/avahi/services/pcloud.service`).
- **Conectar un ordenador (lo normal):** en la web, Ajustes → «Copias de tus ordenadores» → «Conectar un ordenador». En DEV Backup Studio, «Conectar con mi nube…» → escribe el código de 6 cifras. La app encuentra la nube sola, guarda la credencial en el sistema y pone el destino `\\<host>.local\DEV_Backup_Studio\<equipo>`. El código caduca a los 10 minutos y sirve una vez.
- **A mano, en Windows:** Explorador → *Este equipo* → *Conectar unidad de red* → `\\<host>.local\DEV_Backup_Studio`, con el usuario `pcloud-smb` y la contraseña de `sudo cat /etc/pcloud/smb.json`.
- **A mano, en macOS:** Finder → *Ir* → *Conectarse al servidor* → `smb://<host>.local/DEV_Backup_Studio`.
- **Fuera de casa:** solo por Tailscale (`\\<host>\DEV_Backup_Studio`). Nunca se abre el puerto 445 en el router.
- **Sin disco:** la conexión se rechaza (`pcloud-smb-check.sh` exige `/srv/pcloud` montado y el estado READY). DEV Backup Studio espera a que vuelva.
- **Si se borra `DEV_Backup_Studio` desde la web:** se vuelve a crear vacía en la siguiente conexión (con el disco en READY). Lo copiado no vuelve: está en la papelera, si no se ha vaciado.
- **Cambiar la contraseña:** `pcloud-install-smb.sh --new-password --execute`. Después, vuelve a conectar cada ordenador con un código nuevo.
- **Comprobar:** `systemctl status smbd`, `sudo smbstatus`, `testparm -s`, `tail /var/log/samba/log.*`.
- **Recientes del Panel:** lo copiado aparece gracias a `pcloud-smb-recent.service` (lo instala `pcloud-install-smb.sh`). Comprobar: `systemctl status pcloud-smb-recent`, `journalctl -t smbd_audit -n 20`.
- **Apagar:** `pcloud-install-smb.sh --remove --execute`. No borra la carpeta ni lo copiado.
- **Nombre antiguo `Copias`:** al actualizar con `pcloud-install-smb.sh --execute`, la carpeta se renombra (sin copiar nada), la contraseña se conserva y `Copias` queda como alias oculto: los ordenadores ya conectados siguen funcionando.

## 9. Antes de confiar datos únicos

1. **Copia de seguridad:** el sistema no hace copias por sí solo. Ten un segundo disco u otra copia de tus datos.
2. Copia también `/var/lib/pcloud` (base de datos) y la CA de Caddy (`/var/lib/caddy`) fuera del disco del sistema.
3. Usa Ethernet y reserva la IP del servidor en el router.
4. Pon una contraseña robusta al usuario del sistema (`passwd`): ya no sirve para SSH, pero sí para la consola y `sudo`.
