#!/usr/bin/env bash
# pcloud-install-smb.sh — Carpeta de red (SMB) para hacer copias desde los ordenadores de casa
# (ADR-0021). OPCIONAL: no lo ejecuta install.sh.
#
# DRY-RUN por defecto; --execute para aplicar. Idempotente.
#
#   1. Instala samba (sin paquetes recomendados) y apaga nmbd: sin NetBIOS.
#   2. Crea el usuario de sistema pcloud-smb (sin shell ni carpeta personal): es el usuario con el
#      que se conectan los ordenadores. Lo que escriben queda como pcloud, igual que lo de la web.
#   3. Crea la carpeta <raíz de datos>/Copias en el disco de la nube (como pcloud). Exige el disco
#      montado y el StorageGuardian en READY; nunca toca nada más del disco.
#   4. Instala /usr/local/lib/pcloud/pcloud-smb-check.sh, que Samba ejecuta antes de aceptar cada
#      conexión, y /etc/samba/smb.conf desde deploy/linux/samba/smb.conf.tmpl (validado con testparm).
#   5. Si pcloud-smb aún no tiene contraseña (o con --new-password) genera una aleatoria y la
#      muestra UNA vez. No se guarda en ningún fichero.
#
# Uso:
#   sudo bash pcloud-install-smb.sh                    # muestra el plan
#   sudo bash pcloud-install-smb.sh --execute
#   sudo bash pcloud-install-smb.sh --new-password --execute   # cambia la contraseña
#   sudo bash pcloud-install-smb.sh --remove --execute # apaga la carpeta de red (no borra la carpeta
#                                                      # ni lo copiado; samba queda instalado)

set -euo pipefail

EXECUTE=0 REMOVE=0 NEW_PASSWORD=0 SHARE=Copias
while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --remove) REMOVE=1; shift ;;
    --new-password) NEW_PASSWORD=1; shift ;;
    --name) SHARE="${2:-}"; shift 2 ;;
    *) echo "Opción desconocida: $1" >&2; exit 64 ;;
  esac
done
[[ "$SHARE" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$ ]] || { echo "Nombre de carpeta inválido: $SHARE (letras, números, - y _)" >&2; exit 64; }
[ "$(id -u)" -eq 0 ] || { echo "Requiere root" >&2; exit 64; }
die() { echo "ERROR: $*" >&2; exit 1; }

CURRENT=/opt/pcloud/current
CONFIG=/etc/pcloud/config.yaml
SMB_USER=pcloud-smb
SMB_CONF=/etc/samba/smb.conf
ORIGINAL=/etc/samba/smb.conf.pcloud-original
CHECK_DST=/usr/local/lib/pcloud/pcloud-smb-check.sh

if [ "$REMOVE" -eq 1 ]; then
  echo "Plan: parar y deshabilitar smbd, quitar $SMB_USER de Samba y restaurar el smb.conf original."
  echo "      No se borra la carpeta compartida ni nada de lo copiado."
  [ "$EXECUTE" -eq 1 ] || { echo "DRY-RUN: repite con --execute."; exit 0; }
  systemctl disable --now smbd 2>/dev/null || true
  if command -v pdbedit >/dev/null && pdbedit -L 2>/dev/null | grep -q "^$SMB_USER:"; then pdbedit -x -u "$SMB_USER" >/dev/null; fi
  if [ -f "$ORIGINAL" ]; then mv -f "$ORIGINAL" "$SMB_CONF"; fi
  rm -f "$CHECK_DST"
  echo "Carpeta de red apagada. Para quitar Samba del todo: sudo apt-get remove samba"
  exit 0
fi

# ── Comprobaciones ───────────────────────────────────────────────────────────────────────────
[ -L "$CURRENT" ] || die "no hay release activa en $CURRENT"
TMPL="$CURRENT/deploy/linux/samba/smb.conf.tmpl"
CHECK_SRC="$CURRENT/deploy/linux/samba/pcloud-smb-check.sh"
[ -f "$TMPL" ] && [ -f "$CHECK_SRC" ] || die "la release activa no trae la carpeta de red (deploy/linux/samba)"
getent passwd pcloud >/dev/null || die "falta el usuario pcloud: ejecuta antes pcloud-bootstrap.sh --execute"
[ -f "$CONFIG" ] || die "falta $CONFIG"

# Lectura mínima del YAML (claves de una línea dentro de su sección).
yaml_get() {  # yaml_get sección clave
  awk -v sec="$1" -v key="$2" -v q="'" '
    /^[^[:space:]#][^:]*:/ { cur = $1; sub(":", "", cur) }
    cur == sec && $1 == key ":" { v = $2; gsub(/^"|"$/, "", v); gsub("^" q "|" q "$", "", v); print v; exit }
  ' "$CONFIG"
}
MP="$(yaml_get storage mountpoint)"; MP="${MP:-/srv/pcloud}"
ROOT_REL="$(yaml_get storage root_relative)"; ROOT_REL="${ROOT_REL:-data}"
PORT="$(yaml_get server port)"; PORT="${PORT:-3000}"
[ "$MP" = /srv/pcloud ] || die "punto de montaje inesperado en $CONFIG: $MP"
[[ "$ROOT_REL" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$ROOT_REL" != *..* ]] || die "root_relative inesperado: $ROOT_REL"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || die "puerto inesperado: $PORT"
if [ "$ROOT_REL" = "." ]; then DATA="$MP"; else DATA="$MP/$ROOT_REL"; fi
SHARE_PATH="$DATA/$SHARE"

mountpoint -q "$MP" || die "el disco de la nube no está montado en $MP: conéctalo y repite"
HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/v1/system/health" 2>/dev/null)" || die "el servidor no responde en 127.0.0.1:$PORT"
[[ "$HEALTH" == *'"volumeState":"READY"'* ]] || die "el disco no está listo (StorageGuardian distinto de READY): revisa la web antes de seguir"
[ -d "$DATA" ] || die "no existe la raíz de datos $DATA"

# ── Plan ─────────────────────────────────────────────────────────────────────────────────────
PLAN=()
command -v smbd >/dev/null || PLAN+=("instalar samba (apt, sin recomendados)")
getent passwd "$SMB_USER" >/dev/null || PLAN+=("crear el usuario de sistema $SMB_USER (sin shell ni carpeta personal)")
[ -d "$SHARE_PATH" ] || PLAN+=("crear la carpeta $SHARE_PATH (como pcloud)")
cmp -s "$CHECK_SRC" "$CHECK_DST" 2>/dev/null || PLAN+=("instalar $CHECK_DST")
RENDERED="$(sed -e "s|@SHARE@|$SHARE|g" -e "s|@SHARE_PATH@|$SHARE_PATH|g" -e "s|@SMB_USER@|$SMB_USER|g" -e "s|@PORT@|$PORT|g" "$TMPL")"
[ "$(cat "$SMB_CONF" 2>/dev/null)" = "$RENDERED" ] || PLAN+=("escribir $SMB_CONF (carpeta «$SHARE»)")
HAS_PASSWORD=0
if command -v pdbedit >/dev/null && pdbedit -L 2>/dev/null | grep -q "^$SMB_USER:"; then HAS_PASSWORD=1; fi
if [ "$HAS_PASSWORD" -eq 0 ] || [ "$NEW_PASSWORD" -eq 1 ]; then PLAN+=("generar una contraseña nueva para $SMB_USER (se muestra una vez)"); fi
systemctl is-enabled --quiet smbd 2>/dev/null && systemctl is-active --quiet smbd 2>/dev/null || PLAN+=("habilitar y arrancar smbd")
systemctl is-enabled --quiet nmbd 2>/dev/null && PLAN+=("deshabilitar nmbd (sin NetBIOS)")

if [ "${#PLAN[@]}" -eq 0 ]; then echo "Nada que hacer: carpeta de red preparada (\\\\$(hostname -s).local\\$SHARE)."; exit 0; fi
echo "Plan:"
printf '  %s\n' "${PLAN[@]}"
[ "$EXECUTE" -eq 1 ] || { echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."; exit 0; }

# ── Aplicar ──────────────────────────────────────────────────────────────────────────────────
if ! command -v smbd >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y --no-install-recommends samba
fi
systemctl disable --now nmbd 2>/dev/null || true

getent passwd "$SMB_USER" >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SMB_USER"
[ -d "$SHARE_PATH" ] || runuser -u pcloud -- mkdir -- "$SHARE_PATH"

install -d -o root -g root -m 0755 "$(dirname "$CHECK_DST")"
install -o root -g root -m 0755 "$CHECK_SRC" "$CHECK_DST.nuevo"
mv -f "$CHECK_DST.nuevo" "$CHECK_DST"

if [ -f "$SMB_CONF" ] && [ ! -f "$ORIGINAL" ] && ! grep -q 'Personal Cloud Storage' "$SMB_CONF"; then
  cp -p "$SMB_CONF" "$ORIGINAL"
fi
printf '%s\n' "$RENDERED" > "$SMB_CONF.nuevo"
testparm -s "$SMB_CONF.nuevo" >/dev/null 2>&1 || { rm -f "$SMB_CONF.nuevo"; die "testparm rechaza la configuración generada"; }
mv -f "$SMB_CONF.nuevo" "$SMB_CONF"

PASSWORD=""
if [ "$HAS_PASSWORD" -eq 0 ] || [ "$NEW_PASSWORD" -eq 1 ]; then
  # 24 caracteres sin los que se confunden al copiarlos a mano (0/O, 1/l/I)
  PASSWORD="$(LC_ALL=C tr -dc 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789' </dev/urandom | head -c 24)"
  [ "${#PASSWORD}" -eq 24 ] || die "no se pudo generar la contraseña"
  if [ "$HAS_PASSWORD" -eq 1 ]; then
    printf '%s\n%s\n' "$PASSWORD" "$PASSWORD" | smbpasswd -s "$SMB_USER" >/dev/null
  else
    printf '%s\n%s\n' "$PASSWORD" "$PASSWORD" | smbpasswd -s -a "$SMB_USER" >/dev/null
  fi
fi

systemctl enable smbd >/dev/null 2>&1
systemctl restart smbd

HOST="$(hostname -s)"
echo
echo "Carpeta de red preparada."
echo "  Dirección:  \\\\$HOST.local\\$SHARE      (macOS: smb://$HOST.local/$SHARE)"
echo "  Usuario:    $SMB_USER"
if [ -n "$PASSWORD" ]; then
  echo "  Contraseña: $PASSWORD"
  echo "  Apúntala ahora: no se guarda en ningún sitio. Para cambiarla: --new-password --execute"
fi
echo "  En la nube aparece como la carpeta «$SHARE»."
