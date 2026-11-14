#!/usr/bin/env bash
# pcloud-install-share.sh — Prepara la puerta de invitados de los enlaces para compartir (ADR-0018).
#
# No publica nada: Funnel solo se enciende cuando el propietario crea un enlace, y se apaga solo
# cuando no queda ninguno activo. DRY-RUN por defecto; --execute para aplicar. Idempotente.
#
#   1. /var/lib/pcloud/share-agent (pcloud 0700) con inbox/: aquí deja pcloud.service sus peticiones
#      y crea el socket Unix de la puerta de invitados (guest.sock).
#   2. pcloud-share-agent.{path,service} desde la release activa; habilita el .path.
#
# Uso:
#   sudo bash pcloud-install-share.sh             # muestra el plan
#   sudo bash pcloud-install-share.sh --execute
#   sudo bash pcloud-install-share.sh --remove --execute   # retira Funnel :8443 y quita el agente

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
UNITS=(pcloud-share-agent.path pcloud-share-agent.service)
STATE=/var/lib/pcloud/share-agent

if [ "$REMOVE" -eq 1 ]; then
  echo "Plan: retirar Funnel en :8443 (si estaba), desactivar y borrar ${UNITS[*]}"
  [ "$EXECUTE" -eq 1 ] || { echo "DRY-RUN: repite con --execute."; exit 0; }
  if command -v tailscale >/dev/null 2>&1; then timeout 20 tailscale funnel --yes --https=8443 off >/dev/null 2>&1 || true; fi
  systemctl disable --now pcloud-share-agent.path 2>/dev/null || true
  for unit in "${UNITS[@]}"; do rm -f "/etc/systemd/system/$unit"; done
  systemctl daemon-reload
  echo "Puerta de invitados eliminada: nada publicado en Internet."
  exit 0
fi

[ -L "$CURRENT" ] || die "no hay release activa en $CURRENT"
[ -f "$CURRENT/deploy/linux/share/pcloud-share-agent.sh" ] || die "la release activa no trae el agente de la puerta de invitados"
getent passwd pcloud >/dev/null || die "falta el usuario pcloud: ejecuta antes pcloud-bootstrap.sh --execute"
[ -d /var/lib/pcloud ] || die "falta /var/lib/pcloud: ejecuta antes pcloud-bootstrap.sh --execute"

PLAN=()
[ -d "$STATE/inbox" ] || PLAN+=("crear $STATE/inbox (pcloud 0700)")
CHANGED=0
for unit in "${UNITS[@]}"; do
  if ! cmp -s "$CURRENT/deploy/linux/systemd/$unit" "/etc/systemd/system/$unit"; then CHANGED=1; PLAN+=("instalar /etc/systemd/system/$unit"); fi
done
systemctl is-enabled --quiet pcloud-share-agent.path 2>/dev/null || PLAN+=("habilitar pcloud-share-agent.path")
systemctl is-active --quiet pcloud-share-agent.path 2>/dev/null || PLAN+=("arrancar pcloud-share-agent.path")

if [ "${#PLAN[@]}" -eq 0 ]; then echo "Nada que hacer: puerta de invitados preparada."; exit 0; fi
echo "Plan:"
printf '  %s\n' "${PLAN[@]}"
[ "$EXECUTE" -eq 1 ] || { echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."; exit 0; }

install -d -o pcloud -g pcloud -m 0700 "$STATE" "$STATE/inbox"
if [ "$CHANGED" -eq 1 ]; then
  for unit in "${UNITS[@]}"; do
    install -o root -g root -m 0644 "$CURRENT/deploy/linux/systemd/$unit" "/etc/systemd/system/$unit.nueva"
    mv -f "/etc/systemd/system/$unit.nueva" "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
fi
systemctl enable --now pcloud-share-agent.path
echo "Puerta de invitados preparada (apagada hasta que crees un enlace)."
echo "Si el servicio ya estaba en marcha, reinícialo para que abra el socket: systemctl restart pcloud.service"
