#!/usr/bin/env bash
# pcloud-install-power.sh — Permite reiniciar y apagar el equipo desde Ajustes (ADR-0020).
#
# DRY-RUN por defecto; --execute para aplicar. Idempotente. No reinicia ni apaga nada.
#
#   1. /var/lib/pcloud/power-agent/inbox (pcloud 0700): donde pcloud.service deja las peticiones.
#   2. pcloud-power-agent.{path,service} desde la release activa; habilita el .path.
#
# Uso:
#   sudo bash pcloud-install-power.sh             # muestra el plan
#   sudo bash pcloud-install-power.sh --execute
#   sudo bash pcloud-install-power.sh --remove --execute   # quita el agente

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
UNITS=(pcloud-power-agent.path pcloud-power-agent.service)
STATE=/var/lib/pcloud/power-agent

if [ "$REMOVE" -eq 1 ]; then
  echo "Plan: desactivar y borrar ${UNITS[*]}"
  [ "$EXECUTE" -eq 1 ] || { echo "DRY-RUN: repite con --execute."; exit 0; }
  systemctl disable --now pcloud-power-agent.path 2>/dev/null || true
  for unit in "${UNITS[@]}"; do rm -f "/etc/systemd/system/$unit"; done
  systemctl daemon-reload
  echo "Reinicio y apagado desde la web desactivados."
  exit 0
fi

[ -L "$CURRENT" ] || die "no hay release activa en $CURRENT"
[ -f "$CURRENT/deploy/linux/power/pcloud-power-agent.sh" ] || die "la release activa no trae el agente de reinicio y apagado"
getent passwd pcloud >/dev/null || die "falta el usuario pcloud: ejecuta antes pcloud-bootstrap.sh --execute"
[ -d /var/lib/pcloud ] || die "falta /var/lib/pcloud: ejecuta antes pcloud-bootstrap.sh --execute"

PLAN=()
[ -d "$STATE/inbox" ] || PLAN+=("crear $STATE/inbox (pcloud 0700)")
CHANGED=0
for unit in "${UNITS[@]}"; do
  if ! cmp -s "$CURRENT/deploy/linux/systemd/$unit" "/etc/systemd/system/$unit"; then CHANGED=1; PLAN+=("instalar /etc/systemd/system/$unit"); fi
done
systemctl is-enabled --quiet pcloud-power-agent.path 2>/dev/null || PLAN+=("habilitar pcloud-power-agent.path")
systemctl is-active --quiet pcloud-power-agent.path 2>/dev/null || PLAN+=("arrancar pcloud-power-agent.path")

if [ "${#PLAN[@]}" -eq 0 ]; then echo "Nada que hacer: reinicio y apagado desde la web preparados."; exit 0; fi
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
systemctl enable --now pcloud-power-agent.path
echo "Reinicio y apagado desde la web preparados (solo el propietario, con confirmación)."
