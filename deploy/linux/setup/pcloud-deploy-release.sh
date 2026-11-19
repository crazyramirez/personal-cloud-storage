#!/usr/bin/env bash
# pcloud-deploy-release.sh — Instala, activa y revierte releases de la aplicación en /opt/pcloud.
#
# No toca el HDD, /srv/pcloud, /etc/pcloud ni /var/lib/pcloud.
#
#   install  Verifica el manifiesto SHA-256 del paquete, lo extrae en un directorio temporal,
#            instala dependencias de producción (pnpm, sin scripts de instalación), ejecuta los
#            tests EN ESTE HARDWARE como usuario pcloud y solo entonces activa la release
#            con un cambio atómico del enlace /opt/pcloud/current. Si algo falla, la release
#            activa no cambia. Conserva las --keep releases más recientes (por defecto 5).
#            Si pcloud.service está instalado, lo reinicia y comprueba que la API responde CON
#            la release nueva; si no responde, vuelve sola a la release anterior.
#   rollback Activa la release anterior a la actual (y reinicia el servicio).
#   activate Activa una release concreta ya instalada (p. ej. volver adelante tras un rollback).
#   status   Muestra la release activa y las disponibles.
#
# Uso:
#   sudo bash pcloud-deploy-release.sh install /tmp/pcloud-AAAAMMDDTHHMMSSZ.tar.gz [--keep 5] [--skip-tests]
#   sudo bash pcloud-deploy-release.sh rollback
#   sudo bash pcloud-deploy-release.sh activate pcloud-AAAAMMDDTHHMMSSZ
#   bash pcloud-deploy-release.sh status
#
# Los paquetes se crean en el ordenador de desarrollo con deploy/dev/pack-release.sh.

set -euo pipefail

BASE=/opt/pcloud
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
NAME_RE='^pcloud-[0-9]{8}T[0-9]{6}Z$'
WRAPPER=/usr/local/bin/pcloud-volume-status
SERVICE=pcloud.service
UNIT=/etc/systemd/system/pcloud.service
NODE=/usr/local/bin/node

die() { echo "ERROR: $*" >&2; exit 1; }
require_root() { [ "$(id -u)" -eq 0 ] || die "requiere root"; }

current_name() {
  [ -L "$CURRENT" ] || return 0
  basename "$(readlink "$CURRENT")"
}

list_releases() {
  [ -d "$RELEASES" ] || return 0
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E "$NAME_RE" | sort
}

activate() {
  local name="$1"
  [[ "$name" =~ $NAME_RE ]] && [ -d "$RELEASES/$name" ] || die "release inválida: $name"
  ln -sfn "releases/$name" "$BASE/.current.tmp"
  mv -Tf "$BASE/.current.tmp" "$CURRENT"
  echo "Release activa: $name"
}

# Reinicia el servicio (si está instalado y en uso) y espera a que la API responda con la release
# indicada. Devuelve 1 si no responde. Sin servicio instalado no hace nada.
restart_and_check() {
  local expected="$1" _
  if [ ! -e "$UNIT" ]; then
    echo "Servicio $SERVICE no instalado: nada que reiniciar (pcloud-install-service.sh)"
    return 0
  fi
  if ! systemctl is-enabled --quiet "$SERVICE" 2>/dev/null && ! systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    echo "Servicio $SERVICE parado y deshabilitado: no se arranca"
    return 0
  fi
  if [ ! -f "$CURRENT/apps/server/src/main.ts" ] || [ ! -f "$CURRENT/apps/server/src/cli/health.ts" ]; then
    echo "La release $expected no trae servidor: se detiene $SERVICE"
    systemctl stop "$SERVICE" || true
    return 0
  fi
  if ! cmp -s "$CURRENT/deploy/linux/systemd/$SERVICE" "$UNIT"; then
    echo "AVISO: la unidad instalada difiere de la de esta release: ejecuta pcloud-install-service.sh --execute"
  fi
  systemctl restart "$SERVICE" || return 1
  for _ in $(seq 1 30); do
    if runuser -u pcloud -- "$NODE" "$CURRENT/apps/server/src/cli/health.ts"         --config /etc/pcloud/config.yaml --expect-release "$expected" >/dev/null 2>&1; then
      echo "Servicio en marcha con la release $expected"
      # Recientes de la carpeta de red (ADR-0024): si está en marcha, pasa a la release nueva.
      systemctl try-restart pcloud-smb-recent.service 2>/dev/null || true
      return 0
    fi
    sleep 1
  done
  return 1
}

install_wrapper() {
  local content
  content='#!/bin/sh
# Generado por pcloud-deploy-release.sh. Estado del volumen según el StorageGuardian (solo lectura).
# Se ejecuta como el usuario de servicio pcloud para evaluar sus permisos reales.
set -eu
CLI=/opt/pcloud/current/apps/server/src/cli/volume-status.ts
if [ "$(id -un)" = pcloud ]; then exec /usr/local/bin/node "$CLI" --config /etc/pcloud/config.yaml "$@"; fi
if [ "$(id -u)" -eq 0 ]; then exec runuser -u pcloud -- /usr/local/bin/node "$CLI" --config /etc/pcloud/config.yaml "$@"; fi
exec sudo -u pcloud /usr/local/bin/node "$CLI" --config /etc/pcloud/config.yaml "$@"
'
  if [ "$(cat "$WRAPPER" 2>/dev/null)" != "$(printf '%s' "$content")" ]; then
    printf '%s' "$content" > "$WRAPPER"
    chown root:root "$WRAPPER"
    chmod 0755 "$WRAPPER"
    echo "Instalado $WRAPPER"
  fi
}

prune() {
  local keep="$1" active name
  active="$(current_name)"
  mapfile -t all < <(list_releases)
  local excess=$(( ${#all[@]} - keep ))
  for name in "${all[@]}"; do
    [ "$excess" -le 0 ] && break
    [ "$name" = "$active" ] && continue
    [[ "$name" =~ $NAME_RE ]] || continue
    echo "Eliminando release antigua: $name"
    rm -rf -- "${RELEASES:?}/$name"  # pcloud-lint: allow-rm (solo releases antiguas, nombre validado)
    excess=$(( excess - 1 ))
  done
}

cmd_install() {
  require_root
  local tarball="" keep=5 skip_tests=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --keep) keep="${2:-}"; shift 2 ;;
      --skip-tests) skip_tests=1; shift ;;
      -*) die "opción desconocida: $1" ;;
      *) tarball="$1"; shift ;;
    esac
  done
  [[ "$keep" =~ ^[1-9][0-9]*$ ]] || die "--keep debe ser un entero >= 1"
  [ -f "$tarball" ] || die "no existe el paquete: $tarball"
  local name
  name="$(basename "$tarball" .tar.gz)"
  [[ "$name" =~ $NAME_RE ]] || die "nombre de paquete inesperado: $name"
  [ ! -e "$RELEASES/$name" ] || die "la release $name ya existe"
  getent passwd pcloud >/dev/null || die "falta el usuario pcloud: ejecuta antes pcloud-bootstrap.sh --execute"
  command -v pnpm >/dev/null || die "falta pnpm: ejecuta antes pcloud-install-node.sh"

  # Sin tubería hacia grep -q: con pipefail, un SIGPIPE de tar podría ocultar la coincidencia.
  local listing
  listing="$(tar -tzf "$tarball")" || die "el paquete no es un tar.gz legible"
  if grep -Eq '(^/|(^|/)\.\.(/|$))' <<<"$listing"; then
    die "el paquete contiene rutas absolutas o '..'"
  fi

  mkdir -p "$RELEASES"
  STAGING="$(mktemp -d "$RELEASES/.staging-XXXXXX")"
  trap 'rm -rf -- "${STAGING:?}"' EXIT  # pcloud-lint: allow-rm (directorio temporal propio)
  tar -xzf "$tarball" -C "$STAGING" --no-same-owner --no-same-permissions
  (cd "$STAGING" && sha256sum --quiet --strict -c manifest.sha256) || die "el manifiesto SHA-256 no coincide"
  for required in package.json pnpm-lock.yaml release.json apps/server/src/cli/volume-status.ts       apps/server/src/main.ts apps/server/src/cli/health.ts deploy/linux/systemd/pcloud.service       apps/web/.output/public/index.html apps/web/.output/public/200.html; do
    [ -f "$STAGING/$required" ] || die "falta $required en el paquete"
  done

  echo "Instalando dependencias de producción..."
  # HOME y store explícitos: nunca dejar ficheros de root en el home del usuario que invoca sudo.
  (cd "$STAGING" && HOME=/root CI=1 pnpm install --prod --frozen-lockfile --ignore-scripts \
    --store-dir /var/cache/pcloud/pnpm-store --reporter=append-only) >/dev/null
  chown -R root:root "$STAGING"
  chmod -R u=rwX,go=rX "$STAGING"

  if [ "$skip_tests" -eq 0 ]; then
    echo "Ejecutando tests en este hardware como pcloud..."
    (cd "$STAGING" && runuser -u pcloud -- node --test --test-reporter=dot "apps/*/test/**/*.test.ts") \
      || die "los tests fallan en este hardware: la release activa no cambia"
  fi

  local previous
  previous="$(current_name)"
  mv -T "$STAGING" "$RELEASES/$name"
  trap - EXIT
  activate "$name"
  install_wrapper
  if ! restart_and_check "$name"; then
    echo "ERROR: el servicio no responde con la release $name" >&2
    journalctl -u "$SERVICE" -n 25 --no-pager >&2 || true
    if [ -n "$previous" ] && [ "$previous" != "$name" ]; then
      echo "Volviendo a la release anterior ($previous)..." >&2
      activate "$previous"
      restart_and_check "$previous" || echo "ERROR: tampoco responde con $previous: revisar a mano" >&2
      die "la release $name queda instalada pero NO activa"
    fi
    die "la release $name está activa pero el servicio no responde"
  fi
  prune "$keep"
}

cmd_rollback() {
  require_root
  local active previous="" name
  active="$(current_name)"
  [ -n "$active" ] || die "no hay ninguna release activa"
  while IFS= read -r name; do
    [ "$name" = "$active" ] && break
    previous="$name"
  done < <(list_releases)
  [ -n "$previous" ] || die "no hay ninguna release anterior a $active"
  activate "$previous"
  restart_and_check "$previous" || die "el servicio no responde con la release $previous: journalctl -u $SERVICE -n 50"
}

cmd_status() {
  echo "Activa:  $(current_name || true)"
  echo "Disponibles:"
  list_releases | sed 's/^/  /'
  [ -L "$CURRENT" ] && [ -f "$CURRENT/release.json" ] && { echo "release.json:"; sed 's/^/  /' "$CURRENT/release.json"; }
  echo "node $(node --version 2>/dev/null || echo '?') · pnpm $(pnpm --version 2>/dev/null || echo '?')"
  if [ -e "$UNIT" ]; then
    echo "Servicio: $(systemctl is-active "$SERVICE" 2>/dev/null || true) · $(systemctl is-enabled "$SERVICE" 2>/dev/null || true)"
  else
    echo "Servicio: no instalado"
  fi
}

ACTION="${1:-}"
[ $# -gt 0 ] && shift
case "$ACTION" in
  install) cmd_install "$@" ;;
  rollback) cmd_rollback ;;
  activate)
    require_root
    activate "${1:-}"
    install_wrapper
    restart_and_check "${1:-}" || die "el servicio no responde con la release ${1:-}: journalctl -u $SERVICE -n 50"
    ;;
  status) cmd_status ;;
  *) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64 ;;
esac
