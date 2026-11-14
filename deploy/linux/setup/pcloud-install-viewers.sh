#!/usr/bin/env bash
# pcloud-install-viewers.sh — Instala lo que necesitan los visores: ffmpeg (vídeo, audio,
# miniaturas, imágenes HEIC/TIFF) y LibreOffice sin interfaz (Word, Excel, PowerPoint → PDF),
# con fuentes métricamente compatibles con las de Microsoft (Carlito/Caladea/Liberation).
#
# Solo paquetes del repositorio de la distribución. No toca el HDD ni la configuración.
# DRY-RUN por defecto; --execute para aplicar. Idempotente.
#
# Uso:
#   sudo bash pcloud-install-viewers.sh
#   sudo bash pcloud-install-viewers.sh --execute
#
# Deshacer: apt-get remove ffmpeg libreoffice-*-nogui (los visores pasan a «solo descargar»).

set -euo pipefail

EXECUTE=0
[ "${1:-}" = "--execute" ] && EXECUTE=1
[ "$(id -u)" -eq 0 ] || { echo "Requiere root" >&2; exit 64; }

PACKAGES=(
  ffmpeg
  libreoffice-writer-nogui
  libreoffice-calc-nogui
  libreoffice-impress-nogui
  libreoffice-draw-nogui
  fonts-dejavu
  fonts-liberation2
  fonts-crosextra-carlito
  fonts-crosextra-caladea
  fonts-noto-core
)

MISSING=()
for pkg in "${PACKAGES[@]}"; do
  if ! dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed'; then
    MISSING+=("$pkg")
  fi
done

if [ "${#MISSING[@]}" -eq 0 ]; then
  echo "Nada que hacer: visores instalados."
else
  echo "Plan: apt-get install --no-install-recommends ${MISSING[*]}"
  apt-get install -s --no-install-recommends "${MISSING[@]}" 2>/dev/null | awk '/^Inst/ { n++ } END { print "  (" n " paquetes en total, incluidas dependencias)" }'
  if [ "$EXECUTE" -ne 1 ]; then
    echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."
    exit 0
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y --no-install-recommends "${MISSING[@]}"
fi

if [ "$EXECUTE" -eq 1 ] || [ "${#MISSING[@]}" -eq 0 ]; then
  echo "Comprobación:"
  echo "  ffmpeg:      $(ffmpeg -hide_banner -version 2>/dev/null | head -1 | cut -d' ' -f1-3)"
  if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_v4l2m2m && [ -e /dev/video11 ]; then
    echo "  vídeo H.264: codificador por hardware disponible (h264_v4l2m2m, /dev/video11)"
  else
    echo "  vídeo H.264: sin codificador por hardware (se usará libx264, más lento)"
  fi
  echo "  LibreOffice: $(soffice --version 2>/dev/null | head -1 || echo 'no disponible')"
  echo "Reinicia el servicio para que detecte los visores: systemctl restart pcloud"
fi
