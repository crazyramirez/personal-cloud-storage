#!/usr/bin/env bash
# pcloud-smb-check.sh — Samba lo ejecuta (root preexec) antes de aceptar cada conexión a la carpeta
# de red (ADR-0021). Sale con 0 solo si se puede escribir en el disco de la nube:
#
#   1. /srv/pcloud es un punto de montaje (sin disco, el directorio vacío es inmutable).
#   2. El servidor responde y el StorageGuardian dice READY (disco correcto, con espacio, respondiendo).
#   3. La carpeta compartida existe en el disco (si se borró desde la web, se vuelve a crear vacía).
#
# Cualquier otra cosa → 1 y Samba rechaza la conexión: el ordenador ve «carpeta no disponible» y
# DEV Backup Studio espera a que vuelva. Lo único que puede escribir es esa carpeta vacía.
#
# Uso (lo pone smb.conf): pcloud-smb-check.sh <puerto del servidor> <ruta de la carpeta>

set -u
PORT="${1:-3000}"
SHARE_PATH="${2:-}"
MOUNTPOINT=/srv/pcloud

[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || exit 1
[ -n "$SHARE_PATH" ] || exit 1
mountpoint -q "$MOUNTPOINT" || exit 1
body="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/v1/system/health" 2>/dev/null)" || exit 1
[[ "$body" == *'"volumeState":"READY"'* ]] || exit 1
case "$SHARE_PATH" in "$MOUNTPOINT"/*) ;; *) exit 1 ;; esac
if [ ! -d "$SHARE_PATH" ]; then
  # Se borró desde la web: se vuelve a crear vacía, como pcloud. Solo con el disco montado y en
  # READY (comprobado arriba) y dentro de una raíz de datos que existe.
  [ -d "$(dirname "$SHARE_PATH")" ] || exit 1
  runuser -u pcloud -- mkdir -- "$SHARE_PATH" 2>/dev/null || exit 1
fi
exit 0
