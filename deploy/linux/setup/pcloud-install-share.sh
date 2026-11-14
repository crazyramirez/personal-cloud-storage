#!/usr/bin/env bash
# pcloud-install-share.sh — Prepara la puerta de invitados de los enlaces para compartir
# (ADR-0018, ADR-0019).
#
# No publica nada: Funnel solo se enciende cuando el propietario crea un enlace, y se apaga solo
# cuando no queda ninguno activo. DRY-RUN por defecto; --execute para aplicar. Idempotente.
#
#   1. /var/lib/pcloud/share-agent (pcloud 0700) con inbox/: aquí deja pcloud.service sus peticiones
#      y crea el socket Unix de la puerta de invitados (guest.sock).
#   2. pcloud-share-agent.{path,service} desde la release activa; habilita el .path.
#   3. Si Tailscale está instalado: pcloud-share-tailscaled.service, un nodo Tailscale aparte
#      (<host>-compartir, modo userspace) solo para Funnel. Se une a la cuenta la primera vez que
#      se crea un enlace (la app muestra el enlace para iniciar sesión).
#
# Uso:
#   sudo bash pcloud-install-share.sh             # muestra el plan
#   sudo bash pcloud-install-share.sh --execute
#   sudo bash pcloud-install-share.sh --remove --execute   # retira Funnel y quita agente y nodo

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
NODE_UNIT=pcloud-share-tailscaled.service
TS_SOCK=/run/pcloud-share-ts/tailscaled.sock
STATE=/var/lib/pcloud/share-agent
HAS_TS=0
[ -x /usr/sbin/tailscaled ] && command -v tailscale >/dev/null 2>&1 && HAS_TS=1

if [ "$REMOVE" -eq 1 ]; then
  echo "Plan: retirar Funnel, cerrar la sesión del nodo de enlaces, desactivar y borrar ${UNITS[*]} $NODE_UNIT"
  [ "$EXECUTE" -eq 1 ] || { echo "DRY-RUN: repite con --execute."; exit 0; }
  if [ "$HAS_TS" -eq 1 ]; then
    timeout 20 tailscale funnel --yes --https=8443 off >/dev/null 2>&1 || true
    if [ -S "$TS_SOCK" ]; then
      timeout 20 tailscale --socket="$TS_SOCK" funnel --yes --https=443 off >/dev/null 2>&1 || true
      timeout 20 tailscale --socket="$TS_SOCK" logout >/dev/null 2>&1 || true
    fi
  fi
  systemctl disable --now pcloud-share-agent.path "$NODE_UNIT" 2>/dev/null || true
  for unit in "${UNITS[@]}" "$NODE_UNIT"; do rm -f "/etc/systemd/system/$unit"; done
  systemctl daemon-reload
  echo "Puerta de invitados eliminada: nada publicado en Internet."
  exit 0
fi

[ -L "$CURRENT" ] || die "no hay release activa en $CURRENT"
[ -f "$CURRENT/deploy/linux/share/pcloud-share-agent.sh" ] || die "la release activa no trae el agente de la puerta de invitados"
getent passwd pcloud >/dev/null || die "falta el usuario pcloud: ejecuta antes pcloud-bootstrap.sh --execute"
[ -d /var/lib/pcloud ] || die "falta /var/lib/pcloud: ejecuta antes pcloud-bootstrap.sh --execute"

INSTALL_UNITS=("${UNITS[@]}")
[ "$HAS_TS" -eq 1 ] && INSTALL_UNITS+=("$NODE_UNIT")

PLAN=()
[ -d "$STATE/inbox" ] || PLAN+=("crear $STATE/inbox (pcloud 0700)")
CHANGED=0
for unit in "${INSTALL_UNITS[@]}"; do
  if ! cmp -s "$CURRENT/deploy/linux/systemd/$unit" "/etc/systemd/system/$unit"; then CHANGED=1; PLAN+=("instalar /etc/systemd/system/$unit"); fi
done
systemctl is-enabled --quiet pcloud-share-agent.path 2>/dev/null || PLAN+=("habilitar pcloud-share-agent.path")
systemctl is-active --quiet pcloud-share-agent.path 2>/dev/null || PLAN+=("arrancar pcloud-share-agent.path")
if [ "$HAS_TS" -eq 1 ]; then
  systemctl is-enabled --quiet "$NODE_UNIT" 2>/dev/null || PLAN+=("habilitar $NODE_UNIT (nodo Tailscale <host>-compartir, solo para Funnel)")
  systemctl is-active --quiet "$NODE_UNIT" 2>/dev/null || PLAN+=("arrancar $NODE_UNIT")
else
  echo "Aviso: Tailscale no está instalado; los enlaces no serán accesibles desde Internet hasta instalarlo."
fi

if [ "${#PLAN[@]}" -eq 0 ]; then echo "Nada que hacer: puerta de invitados preparada."; exit 0; fi
echo "Plan:"
printf '  %s\n' "${PLAN[@]}"
[ "$EXECUTE" -eq 1 ] || { echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."; exit 0; }

install -d -o pcloud -g pcloud -m 0700 "$STATE" "$STATE/inbox"
if [ "$CHANGED" -eq 1 ]; then
  for unit in "${INSTALL_UNITS[@]}"; do
    install -o root -g root -m 0644 "$CURRENT/deploy/linux/systemd/$unit" "/etc/systemd/system/$unit.nueva"
    mv -f "/etc/systemd/system/$unit.nueva" "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
fi
systemctl enable --now pcloud-share-agent.path
if [ "$HAS_TS" -eq 1 ]; then
  systemctl enable "$NODE_UNIT"
  if [ "$CHANGED" -eq 1 ]; then systemctl restart "$NODE_UNIT"; else systemctl start "$NODE_UNIT"; fi
fi
echo "Puerta de invitados preparada (apagada hasta que crees un enlace)."
echo "Si el servicio ya estaba en marcha, reinícialo para que abra el socket: systemctl restart pcloud.service"
