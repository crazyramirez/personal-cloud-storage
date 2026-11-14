#!/usr/bin/env bash
# pcloud-system-tuning.sh — Ajustes del sistema para un servidor 24/7.
#
# No toca discos de datos ni montajes. DRY-RUN por defecto; --execute para aplicar. Idempotente.
#
#   Wi-Fi: desactiva el ahorro de energía (brcmfmac provoca latencias y cortes en servidores).
#          Inmediato con `iw` y persistente con NetworkManager (se aplica en la próxima
#          activación de la conexión). NO reinicia la conexión: la sesión SSH no se corta.
#          Deshacer: borrar /etc/NetworkManager/conf.d/pcloud-wifi-powersave.conf y
#          ejecutar `iw dev wlan0 set power_save on`.
#
# Uso:
#   sudo bash pcloud-system-tuning.sh
#   sudo bash pcloud-system-tuning.sh --execute

set -euo pipefail

EXECUTE=0
[ "${1:-}" = "--execute" ] && EXECUTE=1
[ "$(id -u)" -eq 0 ] || { echo "Requiere root" >&2; exit 64; }

NM_CONF=/etc/NetworkManager/conf.d/pcloud-wifi-powersave.conf
NM_CONTENT='# Gestionado por pcloud-system-tuning.sh (Personal Cloud Storage).
# 2 = desactivar el ahorro de energía Wi-Fi en las conexiones que no lo fijen explícitamente.
[connection]
wifi.powersave = 2
'

WIFI_DEVS=()
if command -v iw >/dev/null; then
  mapfile -t WIFI_DEVS < <(iw dev | awk '$1 == "Interface" { print $2 }')
fi

PLAN=()
for dev in "${WIFI_DEVS[@]}"; do
  if iw dev "$dev" get power_save 2>/dev/null | grep -q ': on'; then
    PLAN+=("runtime:$dev")
  fi
done
if [ -d /etc/NetworkManager/conf.d ] && [ "$(cat "$NM_CONF" 2>/dev/null)" != "$(printf '%s' "$NM_CONTENT")" ]; then
  PLAN+=("nmconf")
fi

if [ "${#PLAN[@]}" -eq 0 ]; then
  echo "Nada que hacer."
else
  echo "Plan:"
  for item in "${PLAN[@]}"; do
    case "$item" in
      runtime:*) echo "  iw dev ${item#runtime:} set power_save off" ;;
      nmconf) echo "  escribir $NM_CONF (wifi.powersave = 2)" ;;
    esac
  done
  if [ "$EXECUTE" -ne 1 ]; then
    echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."
    exit 0
  fi
  for item in "${PLAN[@]}"; do
    case "$item" in
      runtime:*) iw dev "${item#runtime:}" set power_save off ;;
      nmconf) printf '%s' "$NM_CONTENT" > "$NM_CONF"; chmod 0644 "$NM_CONF" ;;
    esac
  done
fi

for dev in "${WIFI_DEVS[@]}"; do
  echo "$dev: $(iw dev "$dev" get power_save 2>/dev/null)"
done
