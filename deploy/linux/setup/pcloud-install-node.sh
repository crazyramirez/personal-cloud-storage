#!/usr/bin/env bash
# pcloud-install-node.sh — Instala Node.js (versión fijada) y pnpm en /opt/nodejs.
#
# No toca discos de datos ni montajes. Descarga el tarball oficial de nodejs.org
# para la arquitectura del sistema (arm64 o x64),
# verifica su SHA-256 contra SHASUMS256.txt (HTTPS) y lo extrae en /opt/nodejs/<versión>.
# Las versiones anteriores se conservan; para volver atrás basta con reapuntar el enlace
# /opt/nodejs/current. Reejecutarlo es idempotente.
#
# Uso:
#   sudo bash pcloud-install-node.sh [--node v26.13.1] [--pnpm 12.18.0]

set -euo pipefail

NODE_VERSION="v26.13.1"
PNPM_VERSION="12.18.0"
while [ $# -gt 0 ]; do
  case "$1" in
    --node) NODE_VERSION="$2"; shift 2 ;;
    --pnpm) PNPM_VERSION="$2"; shift 2 ;;
    *) echo "Argumento desconocido: $1" >&2; exit 64 ;;
  esac
done
[[ "$NODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Versión de Node inválida" >&2; exit 64; }
[[ "$PNPM_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Versión de pnpm inválida" >&2; exit 64; }
[ "$(id -u)" -eq 0 ] || { echo "Requiere root" >&2; exit 64; }
case "$(dpkg --print-architecture)" in
  arm64) NODE_ARCH=arm64 ;;
  amd64) NODE_ARCH=x64 ;;
  *) echo "Arquitectura no soportada: $(dpkg --print-architecture) (se requiere arm64 o amd64)" >&2; exit 1 ;;
esac

DIST="node-${NODE_VERSION}-linux-${NODE_ARCH}"
TARGET="/opt/nodejs/${DIST}"
WORK="$(mktemp -d)"
trap 'rm -rf -- "${WORK:?}"' EXIT  # pcloud-lint: allow-rm (directorio temporal propio de mktemp)

if [ ! -x "$TARGET/bin/node" ]; then
  echo "Descargando ${DIST}..."
  curl -fsSL --proto '=https' -o "$WORK/${DIST}.tar.xz" "https://nodejs.org/dist/${NODE_VERSION}/${DIST}.tar.xz"
  curl -fsSL --proto '=https' -o "$WORK/SHASUMS256.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
  (cd "$WORK" && grep " ${DIST}.tar.xz\$" SHASUMS256.txt | sha256sum -c -)
  mkdir -p /opt/nodejs
  tar -xJf "$WORK/${DIST}.tar.xz" -C /opt/nodejs
  chown -R root:root "$TARGET"
else
  echo "${DIST} ya instalado"
fi

ln -sfn "$TARGET" /opt/nodejs/current
for bin in node npm npx; do ln -sfn "/opt/nodejs/current/bin/$bin" "/usr/local/bin/$bin"; done

if [ "$(/opt/nodejs/current/bin/pnpm --version 2>/dev/null || true)" != "$PNPM_VERSION" ]; then
  /opt/nodejs/current/bin/npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}"
fi
ln -sfn /opt/nodejs/current/bin/pnpm /usr/local/bin/pnpm

echo "node $(node --version) · npm $(npm --version) · pnpm $(pnpm --version)"
