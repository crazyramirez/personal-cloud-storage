#!/usr/bin/env bash
# pcloud-bootstrap.sh — Usuario de servicio y estructura de directorios del sistema (spec §3.2).
#
# Solo afecta a la microSD. No toca el HDD ni /srv/pcloud (eso es pcloud-mountpoint-guard.sh).
# DRY-RUN por defecto; --execute para aplicar. Idempotente: nunca sobrescribe una configuración
# existente y solo corrige propietario/permisos de los directorios que gestiona (no de su contenido).
#
#   usuario pcloud              de sistema, sin login, home /var/lib/pcloud
#   /etc/pcloud                 root:pcloud   0750
#   /etc/pcloud/config.yaml     root:pcloud   0640  (copia de config.example.yaml si no existe)
#   /var/lib/pcloud             pcloud:pcloud 0700  (SQLite, secretos, locks: SOLO microSD)
#     database/ secrets/ locks/ snapshots-db/      pcloud:pcloud 0700
#   /opt/pcloud                 root:root     0755
#   /opt/pcloud/releases        root:root     0755
#
# Uso:
#   sudo bash pcloud-bootstrap.sh [--config-template RUTA]
#   sudo bash pcloud-bootstrap.sh --execute [--config-template RUTA]

set -euo pipefail

EXECUTE=0
TEMPLATE="$(cd "$(dirname "$0")/../.." && pwd)/config/config.example.yaml"
while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --config-template) TEMPLATE="${2:-}"; shift 2 ;;
    *) echo "Argumento desconocido: $1" >&2; exit 64 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "Requiere root" >&2; exit 64; }

PLAN=()
add() { PLAN+=("$*"); }

if ! getent passwd pcloud >/dev/null; then
  add useradd --system --user-group --home-dir /var/lib/pcloud --no-create-home --shell /usr/sbin/nologin pcloud
fi

# ensure_dir RUTA PROPIETARIO GRUPO MODO
ensure_dir() {
  local path="$1" owner="$2" group="$3" mode="$4"
  if [ ! -e "$path" ]; then
    add install -d -o "$owner" -g "$group" -m "$mode" "$path"
  elif [ ! -d "$path" ] || [ -L "$path" ]; then
    echo "ABORTADO: $path existe y no es un directorio real" >&2
    exit 3
  elif [ "$(stat -c '%U:%G %a' "$path")" != "$owner:$group ${mode#0}" ]; then
    add chown "$owner:$group" "$path"
    add chmod "$mode" "$path"
  fi
}

ensure_dir /etc/pcloud root pcloud 0750
if [ ! -e /etc/pcloud/config.yaml ]; then
  [ -r "$TEMPLATE" ] || { echo "No se encuentra la plantilla de configuración: $TEMPLATE" >&2; exit 64; }
  add install -o root -g pcloud -m 0640 "$TEMPLATE" /etc/pcloud/config.yaml
fi
ensure_dir /var/lib/pcloud pcloud pcloud 0700
for sub in database secrets locks snapshots-db; do
  ensure_dir "/var/lib/pcloud/$sub" pcloud pcloud 0700
done
ensure_dir /opt/pcloud root root 0755
ensure_dir /opt/pcloud/releases root root 0755

if [ "${#PLAN[@]}" -eq 0 ]; then
  echo "Nada que hacer: usuario y directorios ya están como deben."
else
  echo "Plan:"
  printf '  %s\n' "${PLAN[@]}"
  if [ "$EXECUTE" -ne 1 ]; then
    echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."
    exit 0
  fi
  for step in "${PLAN[@]}"; do
    echo "+ $step"
    # Los argumentos no contienen espacios: la separación por palabras es intencionada.
    # shellcheck disable=SC2086
    $step
  done
fi

echo "Estado:"
echo "  $(id pcloud 2>/dev/null || echo 'pcloud: no existe (dry-run)')"
for path in /etc/pcloud /etc/pcloud/config.yaml /var/lib/pcloud /var/lib/pcloud/database /var/lib/pcloud/secrets \
            /var/lib/pcloud/locks /var/lib/pcloud/snapshots-db /opt/pcloud /opt/pcloud/releases; do
  [ -e "$path" ] && stat -c '  %A %U:%G %n' "$path"
done
