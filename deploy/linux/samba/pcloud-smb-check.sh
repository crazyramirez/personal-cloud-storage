#!/usr/bin/env bash
# pcloud-smb-check.sh — Samba lo ejecuta (root preexec) antes de aceptar cada conexión a la carpeta
# de red (ADR-0021). Sale con 0 solo si se puede escribir en el disco de la nube:
#
#   1. /srv/pcloud es un punto de montaje (sin disco, el directorio vacío es inmutable).
#   2. El servidor responde y el StorageGuardian dice READY (disco correcto, con espacio, respondiendo).
#   3. La carpeta compartida existe en el disco.
#
# Cualquier otra cosa → 1 y Samba rechaza la conexión: el ordenador ve «carpeta no disponible» y
# DEV Backup Studio espera a que vuelva. No escribe nada.
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
[ -d "$SHARE_PATH" ] || exit 1
exit 0
