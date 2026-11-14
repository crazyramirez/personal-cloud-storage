#!/usr/bin/env bash
# pcloud-install-service.sh — Instala y arranca el servicio systemd del servidor (pcloud.service).
#
# No toca el HDD, /srv/pcloud, /etc/pcloud ni /var/lib/pcloud. DRY-RUN por defecto; --execute
# para aplicar. Idempotente: si la unidad instalada ya coincide y el servicio responde, no hace nada.
#
#   1. Copia deploy/linux/systemd/pcloud.service de la release ACTIVA a /etc/systemd/system/.
#   2. systemd-analyze verify, daemon-reload, enable.
#   3. Arranca (o reinicia si la unidad cambió) y espera a que la API responda en loopback.
#
# El servicio arranca aunque el disco no esté: sin disco responde 503 en las rutas de ficheros.
#
# Uso:
#   sudo bash pcloud-install-service.sh             # muestra el plan
#   sudo bash pcloud-install-service.sh --execute
#   sudo bash pcloud-install-service.sh --remove --execute   # para, deshabilita y borra la unidad
#
# Deshacer: --remove --execute. No borra datos ni configuración.

set -euo pipefail

EXECUTE=0
REMOVE=0
for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    --remove) REMOVE=1 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 64 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "Requiere root" >&2; exit 64; }

SERVICE=pcloud.service
CURRENT=/opt/pcloud/current
SOURCE="$CURRENT/deploy/linux/systemd/$SERVICE"
TARGET="/etc/systemd/system/$SERVICE"
CONFIG=/etc/pcloud/config.yaml
NODE=/usr/local/bin/node

die() { echo "ERROR: $*" >&2; exit 1; }

health() {
  runuser -u pcloud -- "$NODE" "$CURRENT/apps/server/src/cli/health.ts" --config "$CONFIG" "$@"
}

wait_healthy() {
  local i
  for i in $(seq 1 30); do
    if health >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

if [ "$REMOVE" -eq 1 ]; then
  if [ ! -e "$TARGET" ]; then echo "Nada que hacer: $TARGET no existe."; exit 0; fi
  echo "Plan:"
  echo "  systemctl disable --now $SERVICE"
  echo "  borrar $TARGET y recargar systemd"
  if [ "$EXECUTE" -ne 1 ]; then echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."; exit 0; fi
  systemctl disable --now "$SERVICE" || true
  rm -f "$TARGET"
  systemctl daemon-reload
  echo "Servicio eliminado."
  exit 0
fi

# ── Requisitos (solo lectura) ────────────────────────────────────────────────────────────────
[ -L "$CURRENT" ] || die "no hay release activa en $CURRENT: despliega antes con pcloud-deploy-release.sh"
[ -f "$SOURCE" ] || die "la release activa no trae $SOURCE"
[ -f "$CURRENT/apps/server/src/main.ts" ] || die "la release activa no trae el servidor (apps/server/src/main.ts)"
[ -x "$NODE" ] || die "falta $NODE: ejecuta antes pcloud-install-node.sh"
getent passwd pcloud >/dev/null || die "falta el usuario pcloud: ejecuta antes pcloud-bootstrap.sh --execute"
[ -f "$CONFIG" ] || die "falta $CONFIG"
runuser -u pcloud -- test -r "$CONFIG" || die "el usuario pcloud no puede leer $CONFIG"
runuser -u pcloud -- test -w /var/lib/pcloud/database || die "el usuario pcloud no puede escribir en /var/lib/pcloud/database"

UNIT_CHANGED=0
if ! cmp -s "$SOURCE" "$TARGET"; then UNIT_CHANGED=1; fi
ENABLED=0
systemctl is-enabled --quiet "$SERVICE" 2>/dev/null && ENABLED=1
ACTIVE=0
systemctl is-active --quiet "$SERVICE" 2>/dev/null && ACTIVE=1

PLAN=()
[ "$UNIT_CHANGED" -eq 1 ] && PLAN+=("instalar $TARGET desde la release $(basename "$(readlink "$CURRENT")")")
[ "$ENABLED" -eq 0 ] && PLAN+=("systemctl enable $SERVICE (arranque automático)")
if [ "$ACTIVE" -eq 0 ]; then
  PLAN+=("systemctl start $SERVICE y esperar a que la API responda")
elif [ "$UNIT_CHANGED" -eq 1 ]; then
  PLAN+=("systemctl restart $SERVICE (la unidad cambia) y esperar a que la API responda")
fi

if [ "${#PLAN[@]}" -eq 0 ]; then
  if health >/dev/null 2>&1; then
    echo "Nada que hacer: servicio instalado, habilitado y respondiendo."
    exit 0
  fi
  die "el servicio figura activo pero la API no responde: journalctl -u $SERVICE -n 50"
fi

echo "Plan:"
printf '  %s\n' "${PLAN[@]}"
if [ "$UNIT_CHANGED" -eq 1 ] && [ -e "$TARGET" ]; then
  echo "Diferencias de la unidad (instalada → nueva):"
  diff -u "$TARGET" "$SOURCE" | sed 's/^/  /' || true
fi
if [ "$EXECUTE" -ne 1 ]; then
  echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."
  exit 0
fi

if [ "$UNIT_CHANGED" -eq 1 ]; then
  if [ -e "$TARGET" ]; then cp -p "$TARGET" "$TARGET.anterior"; fi
  install -o root -g root -m 0644 "$SOURCE" "$TARGET.nueva"
  mv -f "$TARGET.nueva" "$TARGET"
  systemctl daemon-reload
  # Avisos de sintaxis de la unidad: se muestran pero no bloquean (el arranque real decide).
  systemd-analyze verify "$TARGET" 2>&1 | sed 's/^/  verify: /' || true
fi
[ "$ENABLED" -eq 0 ] && systemctl enable "$SERVICE"
if [ "$ACTIVE" -eq 0 ]; then
  systemctl start "$SERVICE"
elif [ "$UNIT_CHANGED" -eq 1 ]; then
  systemctl restart "$SERVICE"
fi

if wait_healthy; then
  echo "Servicio en marcha:"
  health | sed 's/^/  /'
  systemctl --no-pager --lines=0 status "$SERVICE" | sed -n '1,6p' | sed 's/^/  /'
else
  echo "ERROR: la API no responde tras arrancar $SERVICE" >&2
  journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
  exit 1
fi
