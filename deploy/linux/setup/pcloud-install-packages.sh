#!/usr/bin/env bash
# pcloud-install-packages.sh — Paquetes del sistema necesarios para operar y diagnosticar.
#
# No toca discos de datos ni montajes. DRY-RUN por defecto; --execute para aplicar.
# --upgrade aplica además las actualizaciones pendientes (apt full-upgrade) conservando
# los ficheros de configuración modificados localmente.
#
#   smartmontools  smartctl para la salud del HDD. Se DESACTIVA el demonio smartd: algunos
#                  puentes USB-SATA se cuelgan con comandos SAT periódicos y además impediría
#                  el reposo del disco. La supervisión la hará la aplicación de forma controlada.
#   hdparm         Consultar/ajustar APM y reposo del HDD (solo tras medir, S0.3).
#   iperf3         Medir el throughput real de la red (S0.3). Sin demonio al arranque.
#   fio            Medir el disco en una carpeta de ensayo de un volumen de laboratorio (S0.3).
#
# Uso:
#   sudo bash pcloud-install-packages.sh                       # plan
#   sudo bash pcloud-install-packages.sh --execute [--upgrade]

set -euo pipefail

PACKAGES=(smartmontools hdparm iperf3 fio)
EXECUTE=0 UPGRADE=0
for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    --upgrade) UPGRADE=1 ;;
    *) echo "Argumento desconocido: $arg" >&2; exit 64 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "Requiere root" >&2; exit 64; }

export DEBIAN_FRONTEND=noninteractive
APT=(apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

echo "Plan:"
echo "  apt-get update"
[ "$UPGRADE" -eq 1 ] && echo "  apt-get full-upgrade  ($(apt list --upgradable 2>/dev/null | tail -n +2 | wc -l) paquetes según los índices actuales)"
echo "  apt-get install --no-install-recommends ${PACKAGES[*]}"
echo "  desactivar smartd (smartmontools.service)"
if [ "$EXECUTE" -ne 1 ]; then
  echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."
  exit 0
fi

echo 'iperf3 iperf3/start_daemon boolean false' | debconf-set-selections
apt-get update
if [ "$UPGRADE" -eq 1 ]; then
  "${APT[@]}" full-upgrade
fi
"${APT[@]}" install --no-install-recommends "${PACKAGES[@]}"

for unit in smartmontools.service smartd.service; do
  if systemctl cat "$unit" >/dev/null 2>&1; then
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
  fi
done
echo "smartd: $(systemctl is-enabled smartmontools.service 2>/dev/null || echo n/a) / $(systemctl is-active smartmontools.service 2>/dev/null || echo n/a)"
if systemctl cat iperf3.service >/dev/null 2>&1; then
  echo "iperf3.service: $(systemctl is-enabled iperf3.service 2>/dev/null || true)"
fi

RUNNING="$(uname -r)"
NEWEST="$(ls -1 /lib/modules | sort -V | tail -n1)"
if [ "$RUNNING" != "$NEWEST" ]; then
  echo "AVISO: kernel en ejecución $RUNNING, instalado $NEWEST → reiniciar para aplicarlo."
fi
echo "Paquetes instalados:"
dpkg-query -W -f='  ${Package} ${Version}\n' "${PACKAGES[@]}"
