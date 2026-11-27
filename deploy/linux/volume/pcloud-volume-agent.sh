#!/usr/bin/env bash
# pcloud-volume-agent.sh — Agente root mínimo que repara solo el HDD de datos cuando el kernel lo ha
# puesto en solo lectura con el equipo en marcha (ADR-0032).
#
# exFAT se monta con errors=remount-ro: si el kernel encuentra una incoherencia (típico tras un corte
# de luz), protege el disco pasándolo a solo lectura. pcloud.service lo ve (READ_ONLY,
# MOUNT_READ_ONLY) y deja una petición vacía en
#   /var/lib/pcloud/volume-agent/inbox/<id>.req
# systemd (pcloud-volume-agent.path) lanza este agente como root, que:
#   1. Comprueba por su cuenta que de verdad hace falta: /srv/pcloud montado desde el disco
#      vinculado, en solo lectura, y /etc/fstab pide lectura/escritura. El contenido de la petición
#      no se lee.
#   2. Limita los intentos (3 en 24 h): si vuelve a pasar enseguida, el problema no es del sistema de
#      archivos (disco dañado, alimentación) y se deja en solo lectura.
#   3. Para Samba (si no, el disco está «ocupado»), desmonta y vuelve a montar. El montaje pasa por
#      pcloud-volume-repair.sh, que comprueba y repara antes de montar.
#   4. Vuelve a arrancar lo que haya parado.
#
# Estado para la web: /run/pcloud-volume-repair/status.json (lo escribe también pcloud-volume-repair).
#
# Uso manual (diagnóstico): sudo bash pcloud-volume-agent.sh --dry-run   (solo dice qué haría)

set -uo pipefail
export LC_ALL=C

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
[ "$(id -u)" -eq 0 ] || { echo "requiere root" >&2; exit 64; }

CONFIG=/etc/pcloud/config.yaml
MOUNTPOINT=/srv/pcloud
INBOX=/var/lib/pcloud/volume-agent/inbox
HISTORY_DIR=/var/lib/pcloud-volume-repair
HISTORY="$HISTORY_DIR/attempts"
STATE_DIR=/run/pcloud-volume-repair
STATUS="$STATE_DIR/status.json"
FORCE="$STATE_DIR/force"
SVC_GROUP=pcloud
MAX_ATTEMPTS=3
WINDOW=86400

log() { echo "pcloud-volume-agent: $*"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

STARTED="$(now)"
status() {  # status FASE RESULTADO
  [ "$DRY" -eq 1 ] && return 0
  local phase="$1" result="$2" finished=null tmp gid
  gid="$(getent group "$SVC_GROUP" | cut -d: -f3)"
  install -d -o root -g "${gid:-0}" -m 0750 "$STATE_DIR"
  case "$phase" in done | failed) finished="\"$(now)\"" ;; esac
  [ -n "$result" ] && result="\"$result\"" || result=null
  tmp="$(mktemp "$STATE_DIR/.status.XXXXXX")"
  local step=null step_at=null
  if [ "$phase" = pending ]; then step='"unmount"'; step_at="\"$(now)\""; fi
  printf '{"phase":"%s","trigger":"readonly","result":%s,"startedAt":"%s","finishedAt":%s,"step":%s,"stepStartedAt":%s,"estimateSeconds":null,"fixed":null}\n' \
    "$phase" "$result" "$STARTED" "$finished" "$step" "$step_at" >"$tmp"
  chown root:"${gid:-0}" "$tmp"
  chmod 0640 "$tmp"
  mv -f "$tmp" "$STATUS"
}

# 0. Vaciar el buzón: cada petición es solo un aviso; se atienden todas de una vez.
PENDING=0
if [ -d "$INBOX" ]; then
  shopt -s nullglob
  for file in "$INBOX"/*.req "$INBOX"/.*.tmp; do
    PENDING=1
    [ "$DRY" -eq 1 ] || rm -f -- "$file"
  done
  shopt -u nullglob
fi
[ "$PENDING" -eq 1 ] || [ "$DRY" -eq 1 ] || exit 0

# 1. ¿Hace falta?
UUID="$(sed -n 's/^[[:space:]]*expected_fs_uuid:[[:space:]]*"\{0,1\}\([0-9A-Fa-f-]*\)"\{0,1\}.*/\1/p' "$CONFIG" 2>/dev/null | head -1)"
[[ "$UUID" =~ ^([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}|[0-9A-Fa-f]{16})$ ]] || { log "sin disco vinculado"; exit 0; }
DEVICE="/dev/disk/by-uuid/$UUID"
[ -b "$DEVICE" ] || { log "el disco no está conectado"; exit 0; }
DEV="$(readlink -f "$DEVICE")"
[ "$(findmnt -rn -o TARGET --mountpoint "$MOUNTPOINT" 2>/dev/null)" = "$MOUNTPOINT" ] || { log "$MOUNTPOINT no está montado"; exit 0; }
SOURCE="$(findmnt -rn -o SOURCE --mountpoint "$MOUNTPOINT" | head -1)"
[ "$(readlink -f "$SOURCE")" = "$DEV" ] || { log "en $MOUNTPOINT hay otro disco: no se toca"; exit 0; }
if ! findmnt -rn -o OPTIONS --mountpoint "$MOUNTPOINT" | head -1 | tr ',' '\n' | grep -qx ro; then
  log "el disco ya admite escritura: no hace falta nada"
  exit 0
fi
FSTAB_OPTS="$(awk -v mp="$MOUNTPOINT" '$0 !~ /^[[:space:]]*#/ && $2 == mp { print $4 }' /etc/fstab | head -1)"
if [ -z "$FSTAB_OPTS" ] || printf '%s\n' "$FSTAB_OPTS" | tr ',' '\n' | grep -qx ro; then
  log "/etc/fstab no pide lectura/escritura para $MOUNTPOINT: se respeta"
  exit 0
fi

# 2. Límite de intentos. Si en este arranque la reparación ya no pudo dejarlo limpio (y por eso se
#    montó en solo lectura), repetirla no cambia nada: se reintenta al reiniciar.
if grep -qE '"phase":"failed".*"result":"(errors_left|io_error|limit)"' "$STATUS" 2>/dev/null; then
  log "la reparación ya falló en este arranque: se deja en solo lectura hasta reiniciar"
  exit 0
fi
NOW_S="$(date +%s)"
RECENT=0
if [ -r "$HISTORY" ]; then RECENT="$(awk -v min=$((NOW_S - WINDOW)) '$1 ~ /^[0-9]+$/ && $1 >= min' "$HISTORY" | wc -l)"; fi
if [ "$RECENT" -ge "$MAX_ATTEMPTS" ]; then
  log "ya se ha reparado $RECENT veces en 24 h: se deja en solo lectura (revisar disco y alimentación)"
  status failed limit
  exit 0
fi
if [ "$DRY" -eq 1 ]; then
  log "DRY-RUN: se pararía Samba, se desmontaría $MOUNTPOINT y se volvería a montar comprobando y reparando ($RECENT intentos en 24 h)"
  exit 0
fi
install -d -o root -g root -m 0700 "$HISTORY_DIR"
{ [ -r "$HISTORY" ] && awk -v min=$((NOW_S - WINDOW)) '$1 ~ /^[0-9]+$/ && $1 >= min' "$HISTORY"; echo "$NOW_S"; } >"$HISTORY.nuevo"
mv -f "$HISTORY.nuevo" "$HISTORY"

status pending ""
log "el disco está en solo lectura por un error del sistema de archivos: se repara"

# 3. Liberar el disco, desmontar y volver a montar (pasando por pcloud-volume-repair.sh).
STOPPED=()
restore() {
  local unit
  for unit in "${STOPPED[@]}"; do systemctl start "$unit" || log "no se pudo volver a arrancar $unit"; done
}
trap restore EXIT
stop_unit() {
  if systemctl is-active --quiet "$1"; then
    systemctl stop "$1" && STOPPED+=("$1") && log "parado $1 (se vuelve a arrancar al terminar)"
  fi
}
MOUNT_UNIT="$(systemd-escape -p --suffix=mount "$MOUNTPOINT")"
unmount() {
  local i
  for i in 1 2 3 4 5; do
    timeout 90 systemctl stop "$MOUNT_UNIT" 2>/dev/null
    mountpoint -q "$MOUNTPOINT" || return 0
    sleep "$i"
  done
  return 1
}

stop_unit smbd.service
if ! unmount; then
  # Algo del servidor (una descarga, el índice de búsqueda) aún tiene ficheros abiertos.
  stop_unit pcloud.service
  if ! unmount; then
    log "no se pudo desmontar: el disco sigue ocupado"
    fuser -vm "$MOUNTPOINT" 2>&1 | head -20 || true
    status failed busy
    exit 0
  fi
fi
log "desmontado"

touch "$FORCE"
# Bloquea mientras pcloud-volume-repair.sh comprueba y repara (unos minutos).
if ! timeout 5h systemctl start "$MOUNT_UNIT"; then log "systemd no pudo montar $MOUNTPOINT"; fi
rm -f -- "$FORCE"

# pcloud-volume-repair.sh deja el resultado; si no llegó a escribirlo (p. ej. no encontró el
# dispositivo), lo cierra el agente para que la web no se quede en «reparando».
UNFINISHED=0
grep -qE '"phase":"(pending|running)"' "$STATUS" 2>/dev/null && UNFINISHED=1
if mountpoint -q "$MOUNTPOINT" && ! findmnt -rn -o OPTIONS --mountpoint "$MOUNTPOINT" | head -1 | tr ',' '\n' | grep -qx ro; then
  log "montado de nuevo con escritura"
  [ "$UNFINISHED" -eq 1 ] && status "done" clean
elif mountpoint -q "$MOUNTPOINT"; then
  log "montado en solo lectura: la reparación no lo ha dejado limpio"
  [ "$UNFINISHED" -eq 1 ] && status failed errors_left
else
  log "el disco no ha quedado montado"
  status failed io_error
fi
exit 0
