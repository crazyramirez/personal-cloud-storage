#!/usr/bin/env bash
# pcloud-fstab-entry.sh — Añade (o comprueba) la línea de /etc/fstab del HDD de datos (ADR-0005).
#
# Genera la línea a partir del UUID y del tipo REAL que detecta blkid (exfat → exfat; ntfs → ntfs3),
# con uid/gid reales del usuario de servicio. Nunca modifica otras líneas: si ya existe una entrada
# DISTINTA para el mountpoint, se detiene.
#
# DRY-RUN por defecto. Con --execute: valida un fstab candidato con `findmnt --verify` ANTES de
# tocar /etc/fstab, guarda copia (/etc/fstab.pcloud-AAAAMMDDTHHMMSS), lo instala de forma atómica
# y recarga systemd. Con --mount, además monta y comprueba las opciones efectivas. Idempotente.
#
# Uso:
#   sudo bash pcloud-fstab-entry.sh --uuid 1A2B-3C4D [--mountpoint /srv/pcloud] [--user pcloud]
#   sudo bash pcloud-fstab-entry.sh --uuid 1A2B-3C4D --execute [--mount]

set -euo pipefail

UUID="" MP=/srv/pcloud SVC_USER=pcloud EXECUTE=0 DO_MOUNT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --uuid) UUID="${2:-}"; shift 2 ;;
    --mountpoint) MP="${2:-}"; shift 2 ;;
    --user) SVC_USER="${2:-}"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --mount) DO_MOUNT=1; shift ;;
    *) echo "Argumento desconocido: $1" >&2; exit 64 ;;
  esac
done
die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "requiere root"
[[ "$UUID" =~ ^([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}|[0-9A-Fa-f]{16})$ ]] || die "UUID con formato no válido: '$UUID'"
[[ "$MP" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "$MP" != *..* && "$MP" != */ ]] || die "mountpoint inválido"
[ -d "$MP" ] || die "$MP no existe (ejecuta pcloud-mountpoint-guard.sh apply)"
SVC_UID="$(id -u "$SVC_USER" 2>/dev/null)" || die "no existe el usuario $SVC_USER"
SVC_GID="$(id -g "$SVC_USER")"

DEV="$(readlink -f "/dev/disk/by-uuid/$UUID" 2>/dev/null || true)"
[ -b "$DEV" ] || die "no hay ningún dispositivo con UUID $UUID conectado"
FSTYPE="$(blkid -c /dev/null -s TYPE -o value "$DEV")"
COMMON="rw,nofail,noatime,nodev,nosuid,noexec,uid=$SVC_UID,gid=$SVC_GID,fmask=0177,dmask=0077,x-systemd.device-timeout=15s"
case "$FSTYPE" in
  exfat) LINE="UUID=$UUID $MP exfat $COMMON,iocharset=utf8,errors=remount-ro 0 0" ;;
  ntfs)  LINE="UUID=$UUID $MP ntfs3 $COMMON,iocharset=utf8,windows_names 0 0" ;;
  *) die "tipo de sistema de archivos no admitido en $DEV: '$FSTYPE'" ;;
esac

echo "Dispositivo: $DEV ($FSTYPE)"
echo "Línea: $LINE"

# Entradas existentes (no comentadas) para este mountpoint.
mapfile -t EXISTING < <(awk -v mp="$MP" '$0 !~ /^[[:space:]]*#/ && $2 == mp' /etc/fstab)
if [ "${#EXISTING[@]}" -gt 1 ]; then die "hay ${#EXISTING[@]} entradas para $MP en /etc/fstab: revisar a mano"; fi
if [ "${#EXISTING[@]}" -eq 1 ]; then
  if [ "$(echo "${EXISTING[0]}" | xargs)" = "$LINE" ]; then
    echo "Ya presente en /etc/fstab: nada que hacer."
    NEED_WRITE=0
  else
    die "ya existe otra entrada para $MP: '${EXISTING[0]}'. No se modifica; revisar a mano."
  fi
else
  NEED_WRITE=1
fi

if [ "$EXECUTE" -ne 1 ]; then
  [ "$NEED_WRITE" -eq 1 ] && echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."
  exit 0
fi

if [ "$NEED_WRITE" -eq 1 ]; then
  CANDIDATE="$(mktemp /etc/.fstab.pcloud.XXXXXX)"
  trap 'rm -f "$CANDIDATE"' EXIT
  cp -p /etc/fstab "$CANDIDATE"
  [ -z "$(tail -c1 "$CANDIDATE")" ] || echo >> "$CANDIDATE"
  printf '# Personal Cloud Storage: HDD de datos (pcloud-fstab-entry.sh, %s)\n%s\n' "$(date -u +%Y-%m-%d)" "$LINE" >> "$CANDIDATE"
  findmnt --verify --tab-file "$CANDIDATE" || die "findmnt --verify rechaza el fstab candidato; /etc/fstab no se ha tocado"
  BACKUP="/etc/fstab.pcloud-$(date -u +%Y%m%dT%H%M%S)"
  cp -p /etc/fstab "$BACKUP"
  mv -f "$CANDIDATE" /etc/fstab
  trap - EXIT
  chmod 0644 /etc/fstab
  echo "Añadida. Copia de seguridad: $BACKUP"
  systemctl daemon-reload
fi

findmnt --verify >/dev/null && echo "findmnt --verify: OK"
UNIT="$(systemd-escape -p --suffix=mount "$MP")"
echo "Unidad: $UNIT ($(systemctl show -p ActiveState --value "$UNIT"))"

if [ "$DO_MOUNT" -eq 1 ]; then
  if ! mountpoint -q "$MP"; then systemctl start "$UNIT"; fi
  mountpoint -q "$MP" || die "no se pudo montar $MP"
  echo "Montado: $(findmnt -rn -o SOURCE,FSTYPE,OPTIONS "$MP")"
  OPTS=",$(findmnt -rn -o OPTIONS "$MP"),"
  for want in rw nodev nosuid noexec noatime "uid=$SVC_UID" "gid=$SVC_GID" fmask=0177 dmask=0077; do
    [[ "$OPTS" == *",$want,"* ]] || die "opción efectiva ausente: $want"
  done
  echo "Opciones efectivas verificadas."
fi
