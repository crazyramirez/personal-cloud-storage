#!/usr/bin/env bash
# pcloud-volume-check.sh — Diagnóstico del volumen de datos candidato (FASE 0).
#
# SOLO LECTURA. No monta, no desmonta, no repara, no escribe. Nunca ejecuta mkfs, parted,
# wipefs, ntfsfix (sin -n), fsck con reparación, ni ntfs-3g.probe --readwrite.
# Imprime una línea fstab SUGERIDA; jamás modifica /etc/fstab.
#
# Uso:
#   sudo bash pcloud-volume-check.sh --list
#   sudo bash pcloud-volume-check.sh --uuid <UUID> [--mountpoint /srv/pcloud] [--service-user pcloud]
#   sudo bash pcloud-volume-check.sh --uuid <UUID> --fsck-readonly    # solo con el volumen DESMONTADO
#
# --fsck-readonly ejecuta `fsck.exfat -n` o `ntfsfix -n` (modo sin escritura). Puede tardar
# en discos grandes. Aun así, hazlo primero sobre un volumen de laboratorio.
#
# Códigos de salida: 0 sin problemas, 1 avisos, 2 problemas que bloquean, 3 volumen no encontrado, 64 uso.

set -uo pipefail
export LC_ALL=C.UTF-8 2>/dev/null || export LC_ALL=C

UUID="" MOUNTPOINT="/srv/pcloud" SERVICE_USER="pcloud" LIST=0 FSCK=0
usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --uuid) UUID="${2:-}"; shift 2 ;;
    --mountpoint) MOUNTPOINT="${2:-}"; shift 2 ;;
    --service-user) SERVICE_USER="${2:-}"; shift 2 ;;
    --list) LIST=1; shift ;;
    --fsck-readonly) FSCK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Argumento desconocido: $1" >&2; usage >&2; exit 64 ;;
  esac
done

WARN=0 BLOCK=0
ok()    { printf '  [OK]    %s\n' "$*"; }
warn()  { printf '  [AVISO] %s\n' "$*"; WARN=1; }
block() { printf '  [BLOQUEA] %s\n' "$*"; BLOCK=1; }
info()  { printf '  %s\n' "$*"; }
title() { printf '\n== %s\n' "$*"; }
have()  { command -v "$1" >/dev/null 2>&1; }

if [ "$LIST" -eq 1 ]; then
  title "Particiones candidatas (exfat / ntfs)"
  lsblk -o NAME,SIZE,FSTYPE,FSVER,UUID,LABEL,MOUNTPOINTS,MODEL,TRAN | awk 'NR==1 || /exfat|ntfs/'
  exit 0
fi

# Validación estricta: el UUID se usa para construir una ruta en /dev/disk/by-uuid.
if ! printf '%s' "$UUID" | grep -Eq '^([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}|[0-9A-Fa-f]{16}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$'; then
  echo "UUID ausente o con formato no válido: '$UUID' (usa --list para verlos)" >&2
  exit 64
fi
[ "$(id -u)" -eq 0 ] || echo "Aviso: sin root no se pueden leer las cabeceras del dispositivo; ejecuta con sudo." >&2

BYUUID="/dev/disk/by-uuid/$UUID"
title "Identificación"
if [ ! -e "$BYUUID" ]; then
  echo "  No existe $BYUUID: el disco no está conectado o el UUID es incorrecto." >&2
  exit 3
fi
DEV="$(readlink -f "$BYUUID")"
DISK="/dev/$(lsblk -no PKNAME "$DEV" | head -n1)"
FSTYPE="$(lsblk -no FSTYPE "$DEV" | head -n1)"
info "Dispositivo: $DEV (disco $DISK)"
lsblk -o NAME,SIZE,FSTYPE,FSVER,LABEL,UUID,PTTYPE,MOUNTPOINTS,MODEL,TRAN "$DISK" | sed 's/^/  /'
info "Transporte: $(lsblk -dno TRAN "$DISK")  Rotacional: $(lsblk -dno ROTA "$DISK")"
if [ "$(id -u)" -eq 0 ]; then
  info "blkid (sondeo de bajo nivel, sin caché):"
  blkid -c /dev/null -p -o export "$DEV" 2>&1 | sed 's/^/    /'
fi
NPARTS="$(lsblk -nro TYPE "$DISK" | grep -c part)"
[ "$NPARTS" -eq 1 ] && ok "Una sola partición en el disco" || warn "El disco tiene $NPARTS particiones: confirmar cuál es la de datos"

title "Cabecera del sistema de archivos (lectura de bytes, sin escribir)"
case "$FSTYPE" in
  exfat)
    if [ "$(id -u)" -eq 0 ]; then
      OEM="$(head -c 11 "$DEV" | tail -c 8 | tr -d '\0')"
      [ "$OEM" = "EXFAT   " ] && ok "Firma exFAT presente" || block "Firma exFAT inesperada: '$OEM'"
      FLAGS="$(od -A n -t u2 -j 106 -N 2 "$DEV" | tr -d ' ')"
      BPS="$(od -A n -t u1 -j 108 -N 1 "$DEV" | tr -d ' ')"
      SPC="$(od -A n -t u1 -j 109 -N 1 "$DEV" | tr -d ' ')"
      REV="$(od -A n -t u1 -j 104 -N 2 "$DEV" | awk '{print $2"."$1}')"
      if ! [[ "$FLAGS" =~ ^[0-9]+$ && "$BPS" =~ ^[0-9]+$ && "$SPC" =~ ^[0-9]+$ ]]; then
        block "No se pudo leer la cabecera exFAT (VolumeFlags/geometría): no se puede afirmar que esté limpio"
      else
        info "Revisión exFAT: $REV  Tamaño de clúster: $(( (1 << BPS) * (1 << SPC) / 1024 )) KiB"
        if (( FLAGS & 2 )); then block "VolumeDirty activo: el volumen no se desmontó limpiamente (revisar con fsck.exfat -n desmontado / chkdsk en Windows)"; else ok "VolumeDirty limpio"; fi
        if (( FLAGS & 4 )); then block "MediaFailure activo: el FS registró errores de medio"; else ok "MediaFailure limpio"; fi
        [ $(( (1 << BPS) * (1 << SPC) )) -gt 131072 ] && warn "Clúster > 128 KiB: mucho espacio desperdiciado con ficheros pequeños"
      fi
    else
      warn "Se necesita root para leer la cabecera exFAT"
    fi
    ;;
  ntfs)
    if [ "$(id -u)" -eq 0 ]; then
      OEM="$(head -c 11 "$DEV" | tail -c 8 | tr -d '\0')"
      [ "$OEM" = "NTFS    " ] && ok "Firma NTFS presente" || block "Firma NTFS inesperada: '$OEM'"
    fi
    if findmnt -rn -S "UUID=$UUID" >/dev/null; then
      info "Volumen montado: se omite ntfsinfo (leer un NTFS montado da resultados incoherentes)"
    elif have ntfsinfo; then
      VOLINFO="$(ntfsinfo -m "$DEV" 2>&1)"
      printf '%s\n' "$VOLINFO" | grep -iE 'version|flags|cluster size' | sed 's/^/    /'
      printf '%s\n' "$VOLINFO" | grep -qi 'dirty' && block "NTFS marcado como sucio: reparar con chkdsk en Windows, NUNCA forzar el montaje" || ok "Sin flag dirty según ntfsinfo"
    else
      warn "ntfsinfo no disponible (paquete ntfs-3g): no se puede comprobar el flag dirty"
    fi
    info "La hibernación/Inicio rápido de Windows no se detecta en solo lectura: apaga Windows por completo (Mayús+Apagar) antes de conectar el disco aquí"
    ;;
  *)
    block "Tipo de sistema de archivos '$FSTYPE': el proyecto solo admite exfat o ntfs (nunca se reformatea)"
    ;;
esac

title "Controladores disponibles"
DRIVER=""
if [ "$FSTYPE" = "exfat" ]; then
  if grep -qw exfat /proc/filesystems || modinfo -n exfat >/dev/null 2>&1; then ok "Controlador exfat del kernel disponible"; DRIVER=exfat; else block "Sin controlador exfat en el kernel"; fi
  ls /sbin/mount.exfat* /usr/sbin/mount.exfat* >/dev/null 2>&1 && warn "Existe helper mount.exfat (exfat-fuse): usar -t exfat podría acabar en FUSE; comprobar el tipo real tras montar"
elif [ "$FSTYPE" = "ntfs" ]; then
  if grep -qw ntfs3 /proc/filesystems || modinfo -n ntfs3 >/dev/null 2>&1; then ok "Controlador ntfs3 del kernel disponible"; DRIVER=ntfs3; else warn "ntfs3 no disponible en este kernel"; fi
  if have ntfs-3g; then info "ntfs-3g disponible como alternativa: $(ntfs-3g --version 2>&1 | head -n1)"; [ -z "$DRIVER" ] && DRIVER=ntfs-3g; fi
  [ -z "$DRIVER" ] && block "No hay ningún controlador NTFS de escritura"
  KVER="$(uname -r | cut -d. -f1-2)"
  info "Kernel $KVER: windows_names en ntfs3 requiere un kernel reciente; validar en volumen de laboratorio"
fi

title "Estado de montaje"
MOUNTS="$(findmnt -rn -o TARGET,FSTYPE,OPTIONS -S "UUID=$UUID" || true)"
if [ -z "$MOUNTS" ]; then
  info "No montado"
else
  printf '%s\n' "$MOUNTS" | sed 's/^/  montado: /'
  while read -r target _; do
    case "$target" in
      "$MOUNTPOINT") ;;
      /media/*|/run/media/*) warn "Automontado por el escritorio en $target: desmontar y excluir este UUID de udisks2" ;;
      *) warn "Montado en una ruta no prevista: $target" ;;
    esac
  done < <(printf '%s\n' "$MOUNTS")
  printf '%s\n' "$MOUNTS" | grep -q 'force' && block "Montado con 'force'"
  TARGET="$(printf '%s\n' "$MOUNTS" | head -n1 | awk '{print $1}')"
  title "Contenido existente (metadatos de la raíz, sin recorrer el disco)"
  df -hT "$TARGET" | sed 's/^/  /'
  info "Entradas en la raíz: $(find "$TARGET" -mindepth 1 -maxdepth 1 | wc -l)"
  ls -la --time-style=long-iso "$TARGET" 2>&1 | head -n 60 | sed 's/^/    /'
  for sys in 'System Volume Information' '$RECYCLE.BIN' '.Trashes' '.Spotlight-V100' '.fseventsd' '.pcloud' 'data'; do
    [ -e "$TARGET/$sys" ] && info "Presente: $sys"
  done
  [ -r "$TARGET/.pcloud/volume-id" ] && info "Marcador existente: $(head -c 120 "$TARGET/.pcloud/volume-id")"
  info "Para auditar nombres incompatibles: bash pcloud-name-audit.sh \"$TARGET\""
fi

if [ "$FSCK" -eq 1 ]; then
  title "Comprobación de solo lectura"
  if [ -n "$MOUNTS" ]; then
    block "El volumen está montado: --fsck-readonly solo se ejecuta con el volumen desmontado"
  elif [ "$FSTYPE" = "exfat" ] && have fsck.exfat; then
    fsck.exfat -n "$DEV" 2>&1 | sed 's/^/    /'; info "fsck.exfat -n exit=${PIPESTATUS[0]}"
  elif [ "$FSTYPE" = "ntfs" ] && have ntfsfix; then
    ntfsfix -n "$DEV" 2>&1 | sed 's/^/    /'; info "ntfsfix -n exit=${PIPESTATUS[0]}"
  else
    warn "No hay herramienta de comprobación instalada (exfatprogs / ntfs-3g)"
  fi
fi

title "Usuario de servicio"
if SVC_UID="$(id -u "$SERVICE_USER" 2>/dev/null)"; then
  SVC_GID="$(id -g "$SERVICE_USER")"
  ok "$SERVICE_USER uid=$SVC_UID gid=$SVC_GID"
else
  SVC_UID="<UID>" SVC_GID="<GID>"
  warn "El usuario $SERVICE_USER no existe todavía (se crea en S0.2); la línea fstab lleva marcadores"
fi

title "Línea /etc/fstab SUGERIDA (no se ha escrito nada)"
COMMON="rw,nofail,noatime,nodev,nosuid,noexec,uid=$SVC_UID,gid=$SVC_GID,fmask=0177,dmask=0077,x-systemd.device-timeout=15s"
case "$DRIVER" in
  exfat)   echo "  UUID=$UUID $MOUNTPOINT exfat $COMMON,iocharset=utf8,errors=remount-ro 0 0" ;;
  ntfs3)   echo "  UUID=$UUID $MOUNTPOINT ntfs3 $COMMON,iocharset=utf8,windows_names 0 0" ;;
  ntfs-3g) echo "  UUID=$UUID $MOUNTPOINT ntfs-3g $COMMON,windows_names 0 0" ;;
  *)       echo "  (sin controlador utilizable: no se sugiere línea)" ;;
esac
info "Sin x-systemd.automount (enmascara la ausencia del disco). pass=0: sin fsck automático al arrancar."
info "Antes de usarla: findmnt --verify, montaje manual, prueba en carpeta de ensayo, desmontaje limpio y reinicio."

title "Resultado"
if [ "$BLOCK" -eq 1 ]; then echo "  PROBLEMAS QUE BLOQUEAN: resolver antes de continuar"; exit 2; fi
if [ "$WARN" -eq 1 ]; then echo "  Avisos pendientes de revisar"; exit 1; fi
echo "  Sin problemas detectados"; exit 0
