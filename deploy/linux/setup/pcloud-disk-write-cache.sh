#!/usr/bin/env bash
# pcloud-disk-write-cache.sh — Hace que fsync vacíe de verdad la caché de escritura del HDD USB.
#
# Problema: muchos puentes USB-SATA no exponen la página de caché SCSI. El kernel asume entonces
# "write through" y NUNCA envía SYNCHRONIZE CACHE, aunque la caché del disco esté activa. Un fsync
# termina con los datos en la caché VOLÁTIL del disco: un corte de alimentación o un tirón del cable
# (un 2,5" alimentado por USB se queda sin corriente) puede perder datos ya "confirmados".
#
# Solución: declarar al kernel la caché como "temporary write back" (sin enviar MODE SELECT al disco),
# de modo que fsync/flush emitan SYNCHRONIZE CACHE. Se persiste con una regla udev ligada al número
# de serie ATA del disco, de modo que no afecta a otros discos.
#
# DRY-RUN por defecto. --execute instala la regla, la aplica ya y verifica que el puente acepta los
# vaciados (fsync de prueba sin errores en el registro del kernel). Deshacer: borrar la regla y
# `echo "temporary write through" > /sys/block/sdX/device/scsi_disk/*/cache_type`.
#
# Uso:
#   sudo bash pcloud-disk-write-cache.sh --serial WD-WX00000000000
#   sudo bash pcloud-disk-write-cache.sh --serial WD-WX00000000000 --execute

set -euo pipefail

SERIAL="" EXECUTE=0
RULE=/etc/udev/rules.d/70-pcloud-disk-write-cache.rules
while [ $# -gt 0 ]; do
  case "$1" in
    --serial) SERIAL="${2:-}"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    *) echo "Argumento desconocido: $1" >&2; exit 64 ;;
  esac
done
die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "requiere root"
[[ "$SERIAL" =~ ^[A-Za-z0-9_-]{4,40}$ ]] || die "número de serie inválido"

DISK=""
for dev in /sys/block/sd*; do
  [ -e "$dev" ] || continue
  name="$(basename "$dev")"
  if [ "$(udevadm info --query=property --name="/dev/$name" | sed -n 's/^ID_SERIAL_SHORT=//p')" = "$SERIAL" ]; then DISK="$name"; fi
done
[ -n "$DISK" ] || die "no hay ningún disco conectado con número de serie $SERIAL"

CACHE_FILES=(/sys/block/"$DISK"/device/scsi_disk/*/cache_type)
[ -e "${CACHE_FILES[0]}" ] || die "no se encuentra cache_type para $DISK"
DRIVE_WCE="$(hdparm -W "/dev/$DISK" 2>/dev/null | sed -n 's/.*write-caching *= *\([01]\).*/\1/p')"
echo "Disco: /dev/$DISK (serie $SERIAL)"
echo "  caché de escritura del disco: $([ "$DRIVE_WCE" = 1 ] && echo ACTIVA || echo "${DRIVE_WCE:-desconocida}")"
echo "  visión del kernel: $(cat "/sys/block/$DISK/queue/write_cache") (cache_type=$(cat "${CACHE_FILES[0]}"))"

RULE_CONTENT="# Gestionado por pcloud-disk-write-cache.sh (Personal Cloud Storage). No editar a mano.
# El puente USB no expone la página de caché SCSI: sin esto el kernel asume \"write through\" y fsync
# no vacía la caché volátil del disco. \"temporary\" = solo cambia la visión del kernel.
ACTION==\"add|change\", SUBSYSTEM==\"block\", KERNEL==\"sd?\", ENV{ID_SERIAL_SHORT}==\"$SERIAL\", RUN+=\"/bin/sh -c 'for f in /sys/block/%k/device/scsi_disk/*/cache_type; do echo temporary write back > \$\$f; done'\""

if [ "$DRIVE_WCE" != 1 ]; then
  echo "La caché del disco no está activa (o no se puede consultar): no hace falta nada."
  exit 0
fi
if [ "$(cat "/sys/block/$DISK/queue/write_cache")" = "write back" ] && [ "$(cat "$RULE" 2>/dev/null)" = "$RULE_CONTENT" ]; then
  echo "Ya configurado: el kernel envía vaciados y la regla persistente está instalada."
  exit 0
fi

echo "Plan:"
echo "  instalar $RULE (aplica a la serie $SERIAL)"
echo "  aplicar ya: 'temporary write back' en ${CACHE_FILES[*]}"
echo "  verificar: fsync de prueba sin errores en el registro del kernel"
if [ "$EXECUTE" -ne 1 ]; then echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."; exit 0; fi

printf '%s\n' "$RULE_CONTENT" > "$RULE"
chmod 0644 "$RULE"
udevadm control --reload
for f in "${CACHE_FILES[@]}"; do echo "temporary write back" > "$f"; done
echo "Kernel ahora: $(cat "/sys/block/$DISK/queue/write_cache") (cache_type=$(cat "${CACHE_FILES[0]}"))"

SINCE="$(date +%s)"
MP="$(lsblk -nro MOUNTPOINTS "/dev/$DISK" | grep -m1 . || true)"
if [ -n "$MP" ] && [ -d "$MP/.pcloud/staging" ]; then
  PROBE="$MP/.pcloud/staging/.flush-probe-$$"
  runuser -u pcloud -- sh -c "head -c 8M /dev/urandom > '$PROBE' && sync '$PROBE' && sync '$MP/.pcloud/staging'" \
    || die "el fsync de prueba falló: revisar el registro del kernel"
  runuser -u pcloud -- rm -f "$PROBE"
  echo "fsync de prueba completado en $MP/.pcloud/staging"
else
  sync -f "/dev/$DISK" 2>/dev/null || true
  echo "Volumen no montado: vaciado de prueba sobre el dispositivo"
fi
ERRORS="$(journalctl -k --no-pager -o cat --since "@$SINCE" | grep -iE "$DISK|sync.?cache|i/o error|reset" || true)"
if [ -n "$ERRORS" ]; then
  echo "$ERRORS"
  die "el registro del kernel muestra errores tras activar los vaciados: revertir con 'temporary write through'"
fi
echo "Sin errores en el registro del kernel: los vaciados funcionan con este puente."
