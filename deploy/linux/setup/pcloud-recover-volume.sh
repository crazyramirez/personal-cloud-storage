#!/usr/bin/env bash
# pcloud-recover-volume.sh — Vuelve a poner en servicio el HDD tras una desconexión o un bloqueo
# (runbooks §6 y §6 bis de docs/OPERATIONS.md). NUNCA repara ni formatea nada.
#
#   1. Comprueba que el disco configurado está presente (por UUID).
#   2. Si el punto de montaje sigue montado con un dispositivo que ya no existe (montaje obsoleto),
#      lo desmonta.
#   3. Comprueba el sistema de archivos en SOLO LECTURA (fsck.exfat -n / ntfsfix -n).
#   4. Solo si sale limpio, monta (systemctl start srv-pcloud.mount) y muestra el veredicto del
#      StorageGuardian. Si hay errores, se detiene y no monta: reparar es una decisión aparte.
#
# DRY-RUN por defecto (solo pasos 1 y 3, sin cambiar nada); --execute para desmontar/montar.
#
# Uso:
#   sudo bash pcloud-recover-volume.sh
#   sudo bash pcloud-recover-volume.sh --execute

set -euo pipefail

EXECUTE=0
[ "${1:-}" = "--execute" ] && EXECUTE=1
[ "$(id -u)" -eq 0 ] || { echo "Requiere root" >&2; exit 64; }

CONFIG=/etc/pcloud/config.yaml
MOUNTPOINT=/srv/pcloud
UNIT=srv-pcloud.mount

UUID="$(sed -n 's/^[[:space:]]*expected_fs_uuid:[[:space:]]*"\{0,1\}\([0-9A-Fa-f-]*\)"\{0,1\}.*/\1/p' "$CONFIG" | head -1)"
FSTYPE="$(sed -n 's/^[[:space:]]*fs_type:[[:space:]]*\([a-z0-9-]*\).*/\1/p' "$CONFIG" | head -1)"
[ -n "$UUID" ] || { echo "ERROR: no hay expected_fs_uuid en $CONFIG" >&2; exit 1; }
DEVICE="/dev/disk/by-uuid/$UUID"

echo "Disco configurado: UUID $UUID ($FSTYPE)"
if [ ! -e "$DEVICE" ]; then
  echo "El disco NO está conectado ($DEVICE no existe). Conéctalo al puerto azul y repite."
  exit 2
fi
REAL="$(readlink -f "$DEVICE")"
echo "  presente: $REAL"

# ¿Montaje obsoleto? (montado, pero de un dispositivo que ya no es el actual)
MOUNTED_SOURCE="$(findmnt -n -o SOURCE --target "$MOUNTPOINT" 2>/dev/null || true)"
if [ -n "$MOUNTED_SOURCE" ] && [ "$(findmnt -n -o TARGET --target "$MOUNTPOINT")" = "$MOUNTPOINT" ]; then
  if [ "$(readlink -f "$MOUNTED_SOURCE")" = "$REAL" ] && [ -r "$REAL" ] && timeout 10 stat "$MOUNTPOINT/.pcloud" >/dev/null 2>&1; then
    echo "  ya está montado y responde: no hace falta recuperar nada."
    runuser -u pcloud -- /usr/local/bin/node /opt/pcloud/current/apps/server/src/cli/volume-status.ts --config "$CONFIG" || true
    exit 0
  fi
  echo "  montaje obsoleto o sin respuesta en $MOUNTPOINT ($MOUNTED_SOURCE)"
  if [ "$EXECUTE" -eq 1 ]; then
    timeout 60 systemctl stop "$UNIT" || timeout 30 umount -l "$MOUNTPOINT" || true
    echo "  desmontado"
  else
    echo "  DRY-RUN: se desmontaría con «systemctl stop $UNIT»."
    echo "  (La comprobación del sistema de archivos solo es fiable desmontado: se hará con --execute.)"
    exit 0
  fi
fi

echo "Comprobación de SOLO LECTURA del sistema de archivos:"
set +e
case "$FSTYPE" in
  exfat) timeout 1800 fsck.exfat -n "$DEVICE"; RC=$? ;;
  ntfs3 | ntfs-3g) timeout 1800 ntfsfix -n "$DEVICE"; RC=$? ;;
  *) echo "Tipo $FSTYPE sin comprobación conocida"; RC=1 ;;
esac
set -e
if [ "$RC" -ne 0 ]; then
  echo "La comprobación ha encontrado problemas (código $RC): NO se monta."
  echo "Reparar es una decisión aparte (fsck.exfat -p tras copiar lo importante). Ver OPERATIONS §6."
  exit 3
fi
echo "  limpio"

if [ "$EXECUTE" -ne 1 ]; then
  echo "DRY-RUN: se montaría con «systemctl start $UNIT». Repite con --execute."
  exit 0
fi
systemctl start "$UNIT"
sleep 2
echo "Veredicto del StorageGuardian:"
runuser -u pcloud -- /usr/local/bin/node /opt/pcloud/current/apps/server/src/cli/volume-status.ts --config "$CONFIG" || true
