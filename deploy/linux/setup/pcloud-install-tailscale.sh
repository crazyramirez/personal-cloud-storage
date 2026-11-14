#!/usr/bin/env bash
# pcloud-install-tailscale.sh — Acceso desde Internet por Tailscale (VPN cifrada; sin abrir puertos).
#
#   1. Instala tailscale desde el repositorio oficial de Tailscale (firma verificada por apt).
#   2. Permite al usuario caddy pedir el certificado HTTPS de *.ts.net a tailscaled
#      (TS_PERMIT_CERT_UID=caddy): la web tiene un certificado válido también fuera de casa.
#   3. tailscale up --hostname=<nombre del equipo>: muestra un enlace para autorizar el servidor en tu cuenta.
#
# Nunca publica la web en Internet (no usa «funnel»): solo tus dispositivos de Tailscale llegan.
# DRY-RUN por defecto; --execute para aplicar. Idempotente.
#
# Deshacer: tailscale down; apt-get remove tailscale.

set -euo pipefail

EXECUTE=0
TS_HOSTNAME="$(hostname -s)"
while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --hostname) TS_HOSTNAME="${2:-}"; shift 2 ;;
    *) echo "Argumento desconocido: $1" >&2; exit 64 ;;
  esac
done
[[ "$TS_HOSTNAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "Nombre de equipo inválido: $TS_HOSTNAME" >&2; exit 64; }
[ "$(id -u)" -eq 0 ] || { echo "Requiere root" >&2; exit 64; }

CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
# Repositorio de Tailscale: «ubuntu» para Ubuntu; «debian» para Debian y Raspberry Pi OS.
DISTRO="$(. /etc/os-release && [ "${ID:-}" = "ubuntu" ] && echo ubuntu || echo debian)"
KEYRING=/usr/share/keyrings/tailscale-archive-keyring.gpg
LIST=/etc/apt/sources.list.d/tailscale.list
DEFAULTS=/etc/default/tailscaled

PLAN=()
command -v tailscale >/dev/null || PLAN+=("instalar tailscale (repositorio oficial, $DISTRO $CODENAME)")
grep -q '^TS_PERMIT_CERT_UID=caddy' "$DEFAULTS" 2>/dev/null || PLAN+=("permitir a caddy obtener el certificado HTTPS (TS_PERMIT_CERT_UID=caddy)")
PLAN+=("tailscale up --hostname=$TS_HOSTNAME (enlace de autorización)")
echo "Plan:"; printf '  %s\n' "${PLAN[@]}"
[ "$EXECUTE" -eq 1 ] || { echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."; exit 0; }

if ! command -v tailscale >/dev/null; then
  curl -fsSL "https://pkgs.tailscale.com/stable/${DISTRO}/${CODENAME}.noarmor.gpg" -o "$KEYRING.nuevo"
  mv -f "$KEYRING.nuevo" "$KEYRING"
  curl -fsSL "https://pkgs.tailscale.com/stable/${DISTRO}/${CODENAME}.tailscale-keyring.list" -o "$LIST.nuevo"
  mv -f "$LIST.nuevo" "$LIST"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y --no-install-recommends tailscale
fi

touch "$DEFAULTS"
if ! grep -q '^TS_PERMIT_CERT_UID=caddy' "$DEFAULTS"; then
  echo 'TS_PERMIT_CERT_UID=caddy' >> "$DEFAULTS"
  systemctl restart tailscaled
fi
systemctl enable --now tailscaled

# --timeout: devuelve el control; el enlace de autorización queda en la salida.
tailscale up --hostname="$TS_HOSTNAME" --ssh=false --accept-dns=false --timeout=20s 2>&1 || true
tailscale status 2>&1 | head -5 || true
