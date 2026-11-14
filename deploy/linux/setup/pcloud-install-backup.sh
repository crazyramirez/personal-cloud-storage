#!/usr/bin/env bash
# pcloud-install-backup.sh — Prepara la copia de seguridad en disco externo (ADR-0017).
#
# No toca ningún disco. DRY-RUN por defecto; --execute para aplicar. Idempotente.
#
#   1. /var/lib/pcloud/backup-agent/inbox (pcloud 0700): donde pcloud.service deja las peticiones.
#   2. /srv/pcloud-backup protegido como /srv/pcloud (root 0555 + inmutable): sin disco de copia
#      montado nadie puede escribir ahí, así que la copia nunca acaba en la tarjeta del sistema.
#   3. pcloud-backup-agent.{path,service} desde la release activa; habilita el .path.
#
# Uso:
#   sudo bash pcloud-install-backup.sh             # muestra el plan
#   sudo bash pcloud-install-backup.sh --execute
#   sudo bash pcloud-install-backup.sh --remove --execute   # quita el agente (no toca discos ni datos)

set -euo pipefail

EXECUTE=0 REMOVE=0
for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    --remove) REMOVE=1 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 64 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "Requiere root" >&2; exit 64; }
die() { echo "ERROR: $*" >&2; exit 1; }

CURRENT=/opt/pcloud/current
UNITS=(pcloud-backup-agent.path pcloud-backup-agent.service)
STATE=/var/lib/pcloud/backup-agent
MP=/srv/pcloud-backup
GUARD="$CURRENT/deploy/linux/setup/pcloud-mountpoint-guard.sh"

if [ "$REMOVE" -eq 1 ]; then
  echo "Plan: desactivar y borrar ${UNITS[*]} (no se tocan $MP, $STATE ni ningún disco)"
  [ "$EXECUTE" -eq 1 ] || { echo "DRY-RUN: repite con --execute."; exit 0; }
  systemctl disable --now pcloud-backup-agent.path 2>/dev/null || true
  for unit in "${UNITS[@]}"; do rm -f "/etc/systemd/system/$unit"; done
  systemctl daemon-reload
  echo "Agente de copia eliminado."
  exit 0
fi

[ -L "$CURRENT" ] || die "no hay release activa en $CURRENT"
[ -f "$CURRENT/deploy/linux/backup/pcloud-backup-agent.sh" ] || die "la release activa no trae el agente de copia"
getent passwd pcloud >/dev/null || die "falta el usuario pcloud: ejecuta antes pcloud-bootstrap.sh --execute"
[ -d /var/lib/pcloud ] || die "falta /var/lib/pcloud: ejecuta antes pcloud-bootstrap.sh --execute"

PLAN=()
[ -d "$STATE/inbox" ] || PLAN+=("crear $STATE/inbox (pcloud 0700)")
GUARD_NEEDED=0
if [ ! -d "$MP" ]; then
  GUARD_NEEDED=1
elif ! mountpoint -q "$MP" && ! lsattr -d "$MP" 2>/dev/null | awk '{ print $1 }' | grep -q i; then
  GUARD_NEEDED=1
fi
[ "$GUARD_NEEDED" -eq 1 ] && PLAN+=("proteger $MP (root 0555 + inmutable) con pcloud-mountpoint-guard.sh")
CHANGED=0
for unit in "${UNITS[@]}"; do
  if ! cmp -s "$CURRENT/deploy/linux/systemd/$unit" "/etc/systemd/system/$unit"; then CHANGED=1; PLAN+=("instalar /etc/systemd/system/$unit"); fi
done
systemctl is-enabled --quiet pcloud-backup-agent.path 2>/dev/null || PLAN+=("habilitar pcloud-backup-agent.path")
systemctl is-active --quiet pcloud-backup-agent.path 2>/dev/null || PLAN+=("arrancar pcloud-backup-agent.path")

if [ "${#PLAN[@]}" -eq 0 ]; then echo "Nada que hacer: copia de seguridad preparada."; exit 0; fi
echo "Plan:"
printf '  %s\n' "${PLAN[@]}"
[ "$EXECUTE" -eq 1 ] || { echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."; exit 0; }

install -d -o pcloud -g pcloud -m 0700 "$STATE" "$STATE/inbox"
if [ "$GUARD_NEEDED" -eq 1 ]; then bash "$GUARD" apply --execute --mountpoint "$MP"; fi
if [ "$CHANGED" -eq 1 ]; then
  for unit in "${UNITS[@]}"; do
    install -o root -g root -m 0644 "$CURRENT/deploy/linux/systemd/$unit" "/etc/systemd/system/$unit.nueva"
    mv -f "/etc/systemd/system/$unit.nueva" "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
fi
systemctl enable --now pcloud-backup-agent.path
echo "Copia de seguridad preparada: agente activo y $MP protegido."
