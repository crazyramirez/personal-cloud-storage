#!/usr/bin/env bash
# pcloud-install-volume-repair.sh — Prepara la reparación automática del HDD de datos (ADR-0032):
# comprobar y reparar antes de cada montaje si quedó sin desmontar bien (corte de luz) y reparar
# solo cuando el kernel lo pone en solo lectura.
#
# DRY-RUN por defecto; --execute para aplicar. Idempotente. No monta, no desmonta ni comprueba
# ningún disco: solo deja instaladas las piezas (se usan en el siguiente montaje).
#
#   1. /var/lib/pcloud/volume-agent/inbox (pcloud 0700): donde pcloud.service avisa.
#   2. pcloud-volume-repair.service y el drop-in srv-pcloud.mount.d/pcloud-volume-repair.conf.
#   3. pcloud-volume-agent.{path,service}; habilita el .path.
#
# Uso:
#   sudo bash pcloud-install-volume-repair.sh             # muestra el plan
#   sudo bash pcloud-install-volume-repair.sh --execute
#   sudo bash pcloud-install-volume-repair.sh --remove --execute   # lo quita (no toca el disco)

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
MOUNTPOINT=/srv/pcloud
UNITS=(pcloud-volume-repair.service pcloud-volume-agent.path pcloud-volume-agent.service)
MOUNT_UNIT="$(systemd-escape -p --suffix=mount "$MOUNTPOINT")"
DROPIN_DIR="/etc/systemd/system/$MOUNT_UNIT.d"
DROPIN="$DROPIN_DIR/pcloud-volume-repair.conf"
STATE=/var/lib/pcloud/volume-agent

if [ "$REMOVE" -eq 1 ]; then
  echo "Plan: desactivar y borrar ${UNITS[*]} y $DROPIN"
  [ "$EXECUTE" -eq 1 ] || { echo "DRY-RUN: repite con --execute."; exit 0; }
  systemctl disable --now pcloud-volume-agent.path 2>/dev/null || true
  for unit in "${UNITS[@]}"; do rm -f "/etc/systemd/system/$unit"; done
  rm -f "$DROPIN"
  rmdir "$DROPIN_DIR" 2>/dev/null || true
  systemctl daemon-reload
  echo "Reparación automática del disco desactivada."
  exit 0
fi

[ -L "$CURRENT" ] || die "no hay release activa en $CURRENT"
[ -f "$CURRENT/deploy/linux/volume/pcloud-volume-repair.sh" ] || die "la release activa no trae la comprobación del disco"
getent passwd pcloud >/dev/null || die "falta el usuario pcloud: ejecuta antes pcloud-bootstrap.sh --execute"
[ -d /var/lib/pcloud ] || die "falta /var/lib/pcloud: ejecuta antes pcloud-bootstrap.sh --execute"
command -v fsck.exfat >/dev/null || echo "Aviso: falta fsck.exfat (paquete exfatprogs): los discos exFAT no se podrán reparar"

PLAN=()
[ -d "$STATE/inbox" ] || PLAN+=("crear $STATE/inbox (pcloud 0700)")
CHANGED=0
for unit in "${UNITS[@]}"; do
  if ! cmp -s "$CURRENT/deploy/linux/systemd/$unit" "/etc/systemd/system/$unit"; then CHANGED=1; PLAN+=("instalar /etc/systemd/system/$unit"); fi
done
if ! cmp -s "$CURRENT/deploy/linux/systemd/pcloud-volume-repair.mount.conf" "$DROPIN"; then CHANGED=1; PLAN+=("instalar $DROPIN"); fi
systemctl is-enabled --quiet pcloud-volume-agent.path 2>/dev/null || PLAN+=("habilitar pcloud-volume-agent.path")
systemctl is-active --quiet pcloud-volume-agent.path 2>/dev/null || PLAN+=("arrancar pcloud-volume-agent.path")

if [ "${#PLAN[@]}" -eq 0 ]; then echo "Nada que hacer: reparación automática del disco preparada."; exit 0; fi
echo "Plan:"
printf '  %s\n' "${PLAN[@]}"
[ "$EXECUTE" -eq 1 ] || { echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."; exit 0; }

install -d -o pcloud -g pcloud -m 0700 "$STATE" "$STATE/inbox"
if [ "$CHANGED" -eq 1 ]; then
  for unit in "${UNITS[@]}"; do
    install -o root -g root -m 0644 "$CURRENT/deploy/linux/systemd/$unit" "/etc/systemd/system/$unit.nueva"
    mv -f "/etc/systemd/system/$unit.nueva" "/etc/systemd/system/$unit"
  done
  install -d -o root -g root -m 0755 "$DROPIN_DIR"
  install -o root -g root -m 0644 "$CURRENT/deploy/linux/systemd/pcloud-volume-repair.mount.conf" "$DROPIN.nueva"
  mv -f "$DROPIN.nueva" "$DROPIN"
  systemctl daemon-reload
fi
systemctl enable --now pcloud-volume-agent.path
echo "Reparación automática del disco preparada: se comprueba antes de cada montaje si no se apagó bien."
