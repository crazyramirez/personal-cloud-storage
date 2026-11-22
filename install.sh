#!/usr/bin/env bash
# install.sh — Instala Personal Cloud Storage en un solo paso.
#
#   curl -fsSL https://raw.githubusercontent.com/crazyramirez/personal-cloud-storage/main/install.sh | sudo bash
#
# Descarga la última release publicada (web ya compilada), instala todo lo necesario, vincula el
# disco que elijas y deja la nube funcionando en https://<nombre-del-equipo>.local.
#
# Seguro por diseño:
#   - NUNCA formatea, particiona, repara ni borra nada del disco de datos. En el disco solo crea
#     las carpetas «data» y «.pcloud»; lo que ya tenga queda intacto.
#   - Reutiliza los scripts de deploy/linux/setup (idempotentes, verificados): se puede volver a
#     ejecutar las veces que haga falta (para actualizar, añadir el disco más tarde, etc.).
#   - No abre puertos a Internet. El acceso remoto (Tailscale) es opcional y privado.
#
# Opciones (todas opcionales; sin ellas pregunta lo necesario):
#   --disk UUID        usar ese disco (exFAT/NTFS) sin preguntar      --no-disk   no configurar disco ahora
#   --viewers          instalar visores (ffmpeg + LibreOffice)        --no-viewers
#   --tailscale        acceso remoto privado con Tailscale            --no-tailscale
#   --yes, -y          sin preguntas: valores por defecto (disco solo si hay uno compatible)
#   --version vX.Y.Z   instalar esa versión en lugar de la última
#   --release FICHERO  instalar un paquete pcloud-*.tar.gz local (creado con deploy/dev/pack-release.sh)
#   --from-source      compilar desde este repositorio clonado en lugar de descargar la release
#   --upgrade-system   aplicar también las actualizaciones pendientes del sistema (apt full-upgrade)
#   --check            solo diagnosticar (no cambia nada, no necesita root): imprime clave=valor
#                      con el sistema, la instalación y los discos compatibles. Pensado para
#                      asistentes de IA y scripts (ver AGENTS.md).
#
# Variables: PCLOUD_REPO=usuario/repo para instalar desde un fork.
# Registro completo de la instalación: /var/log/pcloud-install.log

set -euo pipefail
export LC_ALL=C.UTF-8 2>/dev/null || export LC_ALL=C

REPO="${PCLOUD_REPO:-crazyramirez/personal-cloud-storage}"
LOG=/var/log/pcloud-install.log
MP=/srv/pcloud
CONFIG=/etc/pcloud/config.yaml
NAME_RE='^pcloud-[0-9]{8}T[0-9]{6}Z$'

DISK=ask VIEWERS=ask TAILSCALE=ask YES=0 VERSION=latest RELEASE_FILE="" FROM_SOURCE=0 UPGRADE=0 CHECK=0

usage() { sed -n '2,30p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true; }

while [ $# -gt 0 ]; do
  case "$1" in
    --disk) DISK="${2:-}"; shift 2 ;;
    --no-disk) DISK=none; shift ;;
    --viewers) VIEWERS=yes; shift ;;
    --no-viewers) VIEWERS=no; shift ;;
    --tailscale) TAILSCALE=yes; shift ;;
    --no-tailscale) TAILSCALE=no; shift ;;
    -y|--yes) YES=1; shift ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --release) RELEASE_FILE="${2:-}"; shift 2 ;;
    --from-source) FROM_SOURCE=1; shift ;;
    --upgrade-system) UPGRADE=1; shift ;;
    --check) CHECK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opción desconocida: $1 (usa --help)" >&2; exit 64 ;;
  esac
done

# ── Presentación ──────────────────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  B=$'\e[1m' DIM=$'\e[2m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' C=$'\e[36m' N=$'\e[0m'
else
  B="" DIM="" G="" Y="" R="" C="" N=""
fi
STEP=0
TOTAL=10
say()  { printf '%s\n' "$*"; }
step() { STEP=$((STEP + 1)); printf '\n%s[%d/%d]%s %s%s%s\n' "$C" "$STEP" "$TOTAL" "$N" "$B" "$*" "$N"; echo "=== [$STEP/$TOTAL] $* ($(date -u +%FT%TZ))" >>"$LOG"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
info() { printf '  %s%s%s\n' "$DIM" "$*" "$N"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  {
  printf '\n%s✗ %s%s\n' "$R" "$*" "$N" >&2
  if [ -s "$LOG" ]; then
    printf '%sÚltimas líneas del registro (%s):%s\n' "$DIM" "$LOG" "$N" >&2
    tail -n 25 "$LOG" | sed 's/^/    /' >&2
  fi
  exit 1
}

# Ejecuta un paso guardando su salida en el registro; si falla, la muestra y aborta.
run() {
  local what="$1"; shift
  echo "+ $*" >>"$LOG"
  if ! "$@" >>"$LOG" 2>&1; then die "Falló: $what"; fi
}

# Preguntas: se leen de la terminal aunque el script llegue por una tubería (curl | sudo bash).
TTY=""
if [ "$YES" -eq 0 ] && { : </dev/tty; } 2>/dev/null; then TTY=/dev/tty; fi
ask_yn() {  # ask_yn "pregunta" s|n  → 0 = sí
  local question="$1" default="$2" answer hint
  if [ -z "$TTY" ]; then [ "$default" = s ]; return; fi
  if [ "$default" = s ]; then hint="S/n"; else hint="s/N"; fi
  printf '  %s?%s %s [%s] ' "$Y" "$N" "$question" "$hint" >/dev/tty
  read -r answer </dev/tty || answer=""
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[sSyY] ]]
}
ask_choice() {  # ask_choice "pregunta" defecto máximo → número elegido en stdout
  local question="$1" default="$2" max="$3" answer
  if [ -z "$TTY" ]; then echo "$default"; return; fi
  while true; do
    printf '  %s?%s %s [%s] ' "$Y" "$N" "$question" "$default" >/dev/tty
    read -r answer </dev/tty || answer=""
    answer="${answer:-$default}"
    if [[ "$answer" =~ ^[0-9]+$ ]] && [ "$answer" -le "$max" ]; then echo "$answer"; return; fi
    printf '    Escribe un número entre 0 y %s.\n' "$max" >/dev/tty
  done
}

# ── Discos compatibles (exFAT/NTFS que no son el disco del sistema) ─────────────────────────

field() { [[ "$2" =~ $1=\"([^\"]*)\" ]] && printf '%s' "${BASH_REMATCH[1]}"; }
scan_disks() {
  ROOT_SRC="$(findmnt -no SOURCE / 2>/dev/null || true)"
  ROOT_DISK="$(lsblk -no PKNAME "$ROOT_SRC" 2>/dev/null | head -n1 || true)"
  if [ -n "$ROOT_DISK" ]; then ROOT_DISK="/dev/$ROOT_DISK"; fi

  CAND_DEV=() CAND_UUID=() CAND_FS=() CAND_DESC=() CAND_MP=() CAND_PK=()
  CAND_SIZE=() CAND_LABEL=() CAND_MODEL=() CAND_TRAN=()
  while IFS= read -r line; do
    fs="$(field FSTYPE "$line" || true)"
    case "$fs" in exfat|ntfs) ;; *) continue ;; esac
    dev="$(field NAME "$line" || true)"
    uuid="$(field UUID "$line" || true)"
    pk="$(field PKNAME "$line" || true)"
    [ -n "$uuid" ] || continue
    if [ -n "$pk" ] && [ "$pk" = "$ROOT_DISK" ]; then continue; fi
    size="$(field SIZE "$line" || true)"
    label="$(field LABEL "$line" || true)"
    model="$(lsblk -dno MODEL "${pk:-$dev}" 2>/dev/null | xargs || true)"
    tran="$(lsblk -dno TRAN "${pk:-$dev}" 2>/dev/null | xargs || true)"
    CAND_DEV+=("$dev"); CAND_UUID+=("$uuid"); CAND_FS+=("$fs"); CAND_PK+=("$pk")
    CAND_SIZE+=("$size"); CAND_LABEL+=("$label"); CAND_MODEL+=("$model"); CAND_TRAN+=("$tran")
    CAND_MP+=("$(field MOUNTPOINT "$line" || true)")
    CAND_DESC+=("$dev · $size · $fs${label:+ «$label»}${model:+ · $model}${tran:+ ($tran)}")
  done < <(lsblk -Ppno NAME,PKNAME,FSTYPE,UUID,SIZE,LABEL,MOUNTPOINT 2>/dev/null)
}

# ── Modo diagnóstico (--check): solo lectura, sin root, salida clave=valor estable ────────────
# Formato: una línea «clave=valor» (el valor puede llevar espacios; nunca saltos de línea).
# Los asistentes de IA lo usan antes y después de instalar (AGENTS.md). No modifica nada,
# no escribe el registro y no muestra secretos (ni el código de configuración).

if [ "$CHECK" -eq 1 ]; then
  kv() { printf '%s=%s\n' "$1" "$(printf '%s' "${2:-}" | tr '\n\r' '  ')"; }
  yn() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
  PROBLEMS=()
  kv check.format 1
  kv system.kernel "$(uname -s) $(uname -r)"
  [ "$(uname -s)" = Linux ] || PROBLEMS+=("no es Linux")
  OS_NAME=""; [ -r /etc/os-release ] && OS_NAME="$(. /etc/os-release && echo "${PRETTY_NAME:-}")"
  kv system.os "$OS_NAME"
  if command -v dpkg >/dev/null; then ARCH="$(dpkg --print-architecture)"; else ARCH="$(uname -m)"; fi
  kv system.arch "$ARCH"
  case "$ARCH" in arm64|amd64) ;; *) PROBLEMS+=("arquitectura $ARCH (hace falta arm64 o amd64)") ;; esac
  SYSTEMD="$(yn test -d /run/systemd/system)"; kv system.systemd "$SYSTEMD"
  [ "$SYSTEMD" = yes ] || PROBLEMS+=("sin systemd")
  CONTAINER=no
  if command -v systemd-detect-virt >/dev/null && systemd-detect-virt --container --quiet; then CONTAINER=yes; PROBLEMS+=("dentro de un contenedor"); fi
  kv system.container "$CONTAINER"
  APT="$(yn command -v apt-get)"; kv system.apt "$APT"
  [ "$APT" = yes ] || PROBLEMS+=("sin apt (Debian/Ubuntu/Raspberry Pi OS)")
  kv system.memory_mb "$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null)"
  kv system.root_free_mb "$(df -Pm / 2>/dev/null | awk 'NR == 2 { print $4 }')"
  if command -v vcgencmd >/dev/null; then kv system.throttled "$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"; fi
  if [ "$(id -u)" -eq 0 ]; then kv system.root yes; kv system.sudo_nopasswd yes
  else kv system.root no; kv system.sudo_nopasswd "$(yn sudo -n true)"; fi
  kv system.internet "$(yn curl -fsS --max-time 8 -o /dev/null https://api.github.com)"
  if [ "${#PROBLEMS[@]}" -eq 0 ]; then kv system.supported yes; else kv system.supported no; kv system.problems "$(IFS=';'; echo "${PROBLEMS[*]}")"; fi

  kv host.name "$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  kv host.ip "$(hostname -I 2>/dev/null | awk '{ print $1 }')"

  if [ -L /opt/pcloud/current ]; then
    kv pcloud.installed yes
    kv pcloud.release "$(basename "$(readlink /opt/pcloud/current)")"
  else
    kv pcloud.installed no
  fi
  svc() { if command -v systemctl >/dev/null; then systemctl is-active "$1" 2>/dev/null || true; else echo unknown; fi; }
  kv pcloud.service "$(svc pcloud)"
  kv caddy.service "$(svc caddy)"
  HEALTH="$(curl -fsS --max-time 5 http://127.0.0.1:3000/api/v1/system/health 2>/dev/null || true)"
  if [ -n "$HEALTH" ]; then
    kv pcloud.health ok
    kv pcloud.volume_state "$(grep -oE '"volumeState":"[^"]*"' <<<"$HEALTH" | cut -d'"' -f4)"
    SETUP_STATUS="$(curl -fsS --max-time 5 http://127.0.0.1:3000/api/v1/setup/status 2>/dev/null || true)"
    if grep -q '"needsOwner":true' <<<"$SETUP_STATUS"; then kv pcloud.needs_owner yes
    elif grep -q '"needsOwner":false' <<<"$SETUP_STATUS"; then kv pcloud.needs_owner no
    else kv pcloud.needs_owner unknown; fi
  else
    kv pcloud.health no
  fi
  kv pcloud.mounted "$(yn mountpoint -q "$MP")"
  if [ -r "$CONFIG" ]; then
    kv pcloud.disk_uuid "$(sed -nE "s/^[[:space:]]*expected_fs_uuid:[[:space:]]*[\"']?([0-9A-Fa-f-]{9,36})[\"']?([[:space:]].*)?\$/\1/p" "$CONFIG" | head -n1)"
  elif [ -e "$CONFIG" ]; then
    kv pcloud.disk_uuid unknown
  fi
  if command -v tailscale >/dev/null; then
    kv tailscale.installed yes
    TS_CONNECTED="$(yn tailscale status)"
    kv tailscale.connected "$TS_CONNECTED"
    # Pasos de la consola de Tailscale (AGENTS.md §2.7), sin root ni jq: «tailscale status --json»
    # sale indentado con 2 espacios. Sin «KeyExpiry» en Self, la caducidad está desactivada.
    if [ "$TS_CONNECTED" = yes ]; then
      TS_JSON="$(tailscale status --json 2>/dev/null || true)"
      if grep -qE '"MagicDNSEnabled": *true' <<<"$TS_JSON"; then kv tailscale.magicdns yes; else kv tailscale.magicdns no; fi
      TS_CERT="$(awk '/^  "CertDomains": *\[ *$/ { on = 1; next } on { gsub(/[ \t",]/, ""); if ($0 ~ /\.ts\.net$/) print; exit }' <<<"$TS_JSON")"
      kv tailscale.cert_domain "$TS_CERT"
      TS_EXPIRY="$(awk '/^  "Self": *\{/ { on = 1; next } on && /^  \}/ { exit } on && /^    "KeyExpiry":/ { gsub(/^[^:]*: *"|".*$/, ""); print; exit }' <<<"$TS_JSON")"
      kv tailscale.key_expiry "${TS_EXPIRY:-disabled}"
      if [ -n "$TS_CERT" ]; then kv tailscale.caddy_site "$(yn grep -qF "$TS_CERT" /etc/caddy/Caddyfile)"; fi
    fi
  else
    kv tailscale.installed no
  fi

  scan_disks
  kv disks.count "${#CAND_DEV[@]}"
  for i in "${!CAND_DEV[@]}"; do
    n=$((i + 1))
    kv "disk.$n.device" "${CAND_DEV[$i]}"
    kv "disk.$n.uuid" "${CAND_UUID[$i]}"
    kv "disk.$n.fs" "${CAND_FS[$i]}"
    kv "disk.$n.size" "${CAND_SIZE[$i]}"
    kv "disk.$n.label" "${CAND_LABEL[$i]}"
    kv "disk.$n.model" "${CAND_MODEL[$i]}"
    kv "disk.$n.transport" "${CAND_TRAN[$i]}"
    kv "disk.$n.mountpoint" "${CAND_MP[$i]}"
    # Montado en /srv/pcloud: es el de esta nube (sin root no se puede leer su contenido).
    if [ "${CAND_MP[$i]}" = "$MP" ]; then
      kv "disk.$n.used_by_pcloud" yes
    elif [ -n "${CAND_MP[$i]}" ] && [ -r "${CAND_MP[$i]}" ]; then
      kv "disk.$n.used_by_pcloud" "$(yn test -e "${CAND_MP[$i]}/.pcloud/volume-id")"
    fi
  done
  exit 0
fi
# ── 1. Comprobaciones ─────────────────────────────────────────────────────────────────────────

printf '\n%sPersonal Cloud Storage%s — instalador\n' "$B" "$N"
printf '%sTu nube en casa: un servidor pequeño, un disco USB y nada más.%s\n' "$DIM" "$N"

[ "$(id -u)" -eq 0 ] || { echo "Ejecútalo como root: curl -fsSL … | sudo bash   (o: sudo bash install.sh)" >&2; exit 64; }
: >>"$LOG" && chmod 0600 "$LOG"

step "Comprobando el sistema"
[ "$(uname -s)" = Linux ] || die "Solo funciona en Linux."
[ -d /run/systemd/system ] || die "Hace falta systemd como sistema de arranque."
if command -v systemd-detect-virt >/dev/null && systemd-detect-virt --container --quiet; then
  die "Dentro de un contenedor no está soportado (la protección del disco necesita ver los montajes reales)."
fi
command -v apt-get >/dev/null && command -v dpkg >/dev/null \
  || die "Este instalador necesita Debian, Ubuntu o Raspberry Pi OS (apt). En otras distribuciones, sigue docs/OPERATIONS.md."
ARCH="$(dpkg --print-architecture)"
case "$ARCH" in arm64|amd64) ;; *) die "Arquitectura $ARCH no soportada: hace falta un sistema de 64 bits (arm64 o amd64). En una Raspberry Pi, instala Raspberry Pi OS de 64 bits." ;; esac
# shellcheck disable=SC1091
OS_NAME="$(. /etc/os-release && echo "${PRETTY_NAME:-Linux}")"
HOST="$(hostname -s | tr '[:upper:]' '[:lower:]')"
ok "$OS_NAME · $ARCH · equipo «$HOST»"
MEM_MB="$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)"
[ "$MEM_MB" -ge 900 ] || warn "Solo hay ${MEM_MB} MB de RAM: funcionará justo (recomendado 2 GB o más)."

WORK="$(mktemp -d /tmp/pcloud-install.XXXXXX)"
cleanup() { rm -rf -- "${WORK:?}"; }  # pcloud-lint: allow-rm (directorio temporal propio de mktemp)
trap cleanup EXIT

# ── 2. Paquetes base ──────────────────────────────────────────────────────────────────────────

step "Instalando paquetes base"
export DEBIAN_FRONTEND=noninteractive
run "apt-get update" apt-get update
BASE_PKGS=(curl ca-certificates xz-utils tar gzip openssl avahi-daemon exfatprogs util-linux e2fsprogs udev)
run "instalar paquetes base" apt-get install -y --no-install-recommends "${BASE_PKGS[@]}"
systemctl enable --now avahi-daemon >>"$LOG" 2>&1 || warn "avahi-daemon no arrancó: el nombre $HOST.local puede no funcionar (usa la IP)."
ok "Listo (incluye avahi para que el equipo se encuentre como $HOST.local)"

# ── 3. Obtener la aplicación ──────────────────────────────────────────────────────────────────

step "Obteniendo la aplicación"
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

TARBALL=""
if [ -n "$RELEASE_FILE" ]; then
  [ -f "$RELEASE_FILE" ] || die "No existe el paquete $RELEASE_FILE"
  TARBALL="$(cd "$(dirname "$RELEASE_FILE")" && pwd)/$(basename "$RELEASE_FILE")"
  ok "Paquete local: $(basename "$TARBALL")"
elif [ "$FROM_SOURCE" -eq 1 ]; then
  [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/deploy/dev/pack-release.sh" ] && [ -f "$SELF_DIR/pnpm-lock.yaml" ] \
    || die "--from-source se usa desde una copia clonada del repositorio: sudo bash ./install.sh --from-source"
  info "Compilando desde $SELF_DIR (unos minutos; en una Raspberry Pi puede tardar 10 o más)…"
  run "instalar Node.js" bash "$SELF_DIR/deploy/linux/setup/pcloud-install-node.sh"
  BUILDER="${SUDO_USER:-root}"
  [ "$BUILDER" != root ] || warn "Se compila como root (ejecuta con sudo desde tu usuario para evitarlo)."
  run "instalar dependencias de compilación" runuser -u "$BUILDER" -- bash -c 'cd "$1" && CI=1 pnpm install --frozen-lockfile' _ "$SELF_DIR"
  run "compilar la release" runuser -u "$BUILDER" -- bash "$SELF_DIR/deploy/dev/pack-release.sh"
  # Los nombres llevan la fecha UTC: el último en orden es el recién creado.
  TARBALL="$(find "$SELF_DIR/.releases" -maxdepth 1 -name 'pcloud-*.tar.gz' | sort | tail -n1)"
  [ -n "$TARBALL" ] || die "La compilación no generó ningún paquete"
  ok "Compilada: $(basename "$TARBALL")"
else
  if [ "$VERSION" = latest ]; then API="https://api.github.com/repos/$REPO/releases/latest"
  else [[ "$VERSION" =~ ^v?[0-9A-Za-z._-]+$ ]] || die "Versión no válida: $VERSION"; API="https://api.github.com/repos/$REPO/releases/tags/$VERSION"; fi
  echo "+ GET $API" >>"$LOG"
  META="$(curl -fsSL --proto '=https' --retry 3 -H 'Accept: application/vnd.github+json' "$API" 2>>"$LOG")" \
    || die "No se pudo consultar la release en GitHub ($REPO, $VERSION). ¿Hay conexión a Internet?"
  URL="$(grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]+/pcloud-[0-9]{8}T[0-9]{6}Z\.tar\.gz"' <<<"$META" | grep -oE 'https://[^"]+' | head -n1 || true)"
  TAG="$(grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' <<<"$META" | head -n1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  [ -n "$URL" ] || die "La release ${TAG:-$VERSION} de $REPO no incluye ningún paquete pcloud-*.tar.gz."
  TARBALL="$WORK/$(basename "$URL")"
  info "Descargando ${TAG:-} ($(basename "$URL"))…"
  run "descargar la release" curl -fsSL --proto '=https' --retry 3 -o "$TARBALL" "$URL"
  if curl -fsSL --proto '=https' --retry 3 -o "$TARBALL.sha256" "$URL.sha256" 2>>"$LOG"; then
    EXPECTED="$(awk '{ print $1; exit }' "$TARBALL.sha256")"
    ACTUAL="$(sha256sum "$TARBALL" | awk '{ print $1 }')"
    [ "$EXPECTED" = "$ACTUAL" ] || die "La suma SHA-256 de la descarga no coincide: no se instala nada."
    ok "Descargada y verificada (SHA-256): ${TAG:-} $(basename "$URL")"
  else
    warn "La release no publica suma SHA-256 aparte; se verificará su manifiesto interno."
  fi
fi

NAME="$(basename "$TARBALL" .tar.gz)"
[[ "$NAME" =~ $NAME_RE ]] || die "Nombre de paquete inesperado: $NAME"
LISTING="$(tar -tzf "$TARBALL")" || die "El paquete no es un .tar.gz válido"
if grep -Eq '(^/|(^|/)\.\.(/|$))' <<<"$LISTING"; then die "El paquete contiene rutas peligrosas"; fi
mkdir -p "$WORK/src"
tar -xzf "$TARBALL" -C "$WORK/src" --no-same-owner
(cd "$WORK/src" && sha256sum --quiet --strict -c manifest.sha256) >>"$LOG" 2>&1 || die "El manifiesto del paquete no coincide: paquete dañado."
SETUP="$WORK/src/deploy/linux/setup"
[ -f "$SETUP/pcloud-deploy-release.sh" ] || die "El paquete no contiene los scripts de instalación"

# ── 4. Sistema: Node.js, paquetes, usuario de servicio, protección del punto de montaje ───────

step "Preparando el sistema (Node.js, usuario de servicio, protecciones)"
info "Puede tardar unos minutos la primera vez…"
run "instalar Node.js y pnpm" bash "$SETUP/pcloud-install-node.sh"
PKG_ARGS=(--execute); [ "$UPGRADE" -eq 1 ] && PKG_ARGS+=(--upgrade)
run "instalar paquetes del sistema" bash "$SETUP/pcloud-install-packages.sh" "${PKG_ARGS[@]}"
run "crear el usuario de servicio y las carpetas" bash "$SETUP/pcloud-bootstrap.sh" --execute
if mountpoint -q "$MP"; then
  ok "El punto de montaje $MP ya está en uso por el disco"
elif lsattr -d "$MP" 2>/dev/null | awk '{ print $1 }' | grep -q i; then
  ok "El punto de montaje $MP ya estaba protegido"
else
  run "proteger el punto de montaje $MP" bash "$SETUP/pcloud-mountpoint-guard.sh" apply --execute
fi
run "ajustes del sistema" bash "$SETUP/pcloud-system-tuning.sh" --execute
ok "Node.js $(node --version), usuario «pcloud», $MP protegido (sin disco nadie puede escribir ahí)"

# ── 5. Aplicación ─────────────────────────────────────────────────────────────────────────────

step "Instalando la aplicación"
CURRENT_NAME="$(basename "$(readlink /opt/pcloud/current 2>/dev/null || echo none)")"
if [ -d "/opt/pcloud/releases/$NAME" ]; then
  if [ "$CURRENT_NAME" = "$NAME" ]; then
    ok "Ya estaba instalada: $NAME"
  else
    run "activar $NAME" bash "$SETUP/pcloud-deploy-release.sh" activate "$NAME"
    ok "Activada: $NAME"
  fi
else
  info "Instalando dependencias y ejecutando las pruebas en este equipo (2-5 minutos)…"
  run "instalar la release $NAME" bash "$SETUP/pcloud-deploy-release.sh" install "$TARBALL"
  ok "Instalada y verificada: $NAME"
fi
APP=/opt/pcloud/current
SETUP="$APP/deploy/linux/setup"   # desde aquí, los scripts de la release activa

# ── 6. Servicio ───────────────────────────────────────────────────────────────────────────────

step "Arrancando el servicio"
# Antes del servicio: crea el directorio donde pcloud.service abre el socket de invitados.
run "preparar la puerta de invitados (enlaces para compartir)" bash "$SETUP/pcloud-install-share.sh" --execute
ok "Enlaces para compartir listos (nada publicado en Internet hasta que crees uno)"
run "instalar pcloud.service" bash "$SETUP/pcloud-install-service.sh" --execute
ok "pcloud.service activo (arranca solo con el equipo, aunque no haya disco)"
run "preparar la copia de seguridad en disco externo" bash "$SETUP/pcloud-install-backup.sh" --execute
ok "Copia de seguridad lista: conecta un disco USB externo y elígelo en Ajustes"
run "preparar reinicio y apagado desde Ajustes" bash "$SETUP/pcloud-install-power.sh" --execute

# ── 7. Visores ────────────────────────────────────────────────────────────────────────────────

step "Visores de vídeo y documentos (opcional)"
if [ "$VIEWERS" = ask ]; then
  if ask_yn "¿Instalar visores para ver vídeos y documentos de Office en el navegador? (ffmpeg + LibreOffice, ~700 MB)" s; then VIEWERS=yes; else VIEWERS=no; fi
fi
if [ "$VIEWERS" = yes ]; then
  info "Descargando ffmpeg y LibreOffice (varios minutos)…"
  run "instalar visores" bash "$SETUP/pcloud-install-viewers.sh" --execute
  ok "Visores instalados"
else
  info "Omitido. Se puede añadir más tarde: sudo bash $SETUP/pcloud-install-viewers.sh --execute"
fi

# ── 8. HTTPS ──────────────────────────────────────────────────────────────────────────────────

step "Configurando HTTPS en tu red"
run "instalar y configurar Caddy" bash "$SETUP/pcloud-install-caddy.sh" --execute
ok "https://$HOST.local con certificado propio"

# ── 9. Disco de datos ─────────────────────────────────────────────────────────────────────────

step "Disco de datos"
scan_disks

PICK=-1
CONFIGURED_UUID="$(sed -nE "s/^[[:space:]]*expected_fs_uuid:[[:space:]]*[\"']?([0-9A-Fa-f-]{9,36})[\"']?([[:space:]].*)?\$/\1/p" "$CONFIG" 2>/dev/null | head -n1 || true)"
if [ "$DISK" = none ]; then
  info "Omitido (--no-disk)."
elif [ "$DISK" != ask ]; then
  for i in "${!CAND_UUID[@]}"; do [ "${CAND_UUID[$i]}" = "$DISK" ] && PICK=$i; done
  [ "$PICK" -ge 0 ] || die "No hay ningún disco exFAT/NTFS conectado con UUID $DISK."
elif [ -n "$CONFIGURED_UUID" ]; then
  for i in "${!CAND_UUID[@]}"; do [ "${CAND_UUID[$i]}" = "$CONFIGURED_UUID" ] && PICK=$i; done
  if [ "$PICK" -ge 0 ]; then info "Disco ya vinculado: ${CAND_DESC[$PICK]}"
  else warn "El disco vinculado ($CONFIGURED_UUID) no está conectado. Conéctalo y vuelve a ejecutar el instalador."; fi
elif [ "${#CAND_DEV[@]}" -eq 0 ]; then
  warn "No hay ningún disco exFAT o NTFS conectado."
  info "Conecta el disco (formateado en exFAT desde Windows o macOS) y vuelve a ejecutar el mismo comando."
else
  say "  Discos compatibles:"
  for i in "${!CAND_DEV[@]}"; do printf '    %s%d)%s %s\n' "$B" $((i + 1)) "$N" "${CAND_DESC[$i]}"; done
  printf '    %s0)%s Ninguno por ahora\n' "$B" "$N"
  if [ -z "$TTY" ] && [ "${#CAND_DEV[@]}" -gt 1 ]; then
    warn "Hay varios discos y no se puede preguntar: elige uno con --disk UUID."
  else
    choice="$(ask_choice "¿Qué disco usar para tu nube?" 1 "${#CAND_DEV[@]}")"
    PICK=$((choice - 1))
    if [ "$PICK" -ge 0 ]; then
      info "No se formatea ni se borra nada: se crean las carpetas «data» (tu nube) y «.pcloud» (uso interno)."
      ask_yn "¿Usar ${CAND_DEV[$PICK]}?" s || PICK=-1
    fi
  fi
fi

DISK_OK=0
if [ "$PICK" -ge 0 ]; then
  DEV="${CAND_DEV[$PICK]}" UUID="${CAND_UUID[$PICK]}" PK="${CAND_PK[$PICK]}" WHERE="${CAND_MP[$PICK]}"
  if [ "${CAND_FS[$PICK]}" = exfat ]; then FS_TYPE=exfat; else FS_TYPE=ntfs3; fi
  if [ -n "$WHERE" ] && [ "$WHERE" != "$MP" ]; then
    info "$DEV está montado en $WHERE: se desmonta para montarlo en $MP."
    run "desmontar $DEV" umount "$DEV"
  fi
  run "añadir el disco a /etc/fstab y montarlo" bash "$SETUP/pcloud-fstab-entry.sh" --uuid "$UUID" --execute --mount
  ADOPT=()
  if [ -e "$MP/.pcloud/volume-id" ] && [ "$UUID" != "$CONFIGURED_UUID" ]; then
    info "El disco ya se usó con Personal Cloud en otra instalación: se readopta (sus datos se conservan)."
    ADOPT=(--adopt-existing)
  fi
  run "vincular el disco" bash "$SETUP/pcloud-onboard-volume.sh" --uuid "$UUID" --fs-type "$FS_TYPE" --execute "${ADOPT[@]}"
  SERIAL=""
  if [ -n "$PK" ] && [[ "$(basename "$PK")" == sd* ]]; then
    SERIAL="$(udevadm info --query=property --name="$PK" 2>/dev/null | sed -n 's/^ID_SERIAL_SHORT=//p' | head -n1)"
  fi
  if [[ "$SERIAL" =~ ^[A-Za-z0-9_-]{4,40}$ ]]; then
    run "asegurar el vaciado de la caché del disco" bash "$SETUP/pcloud-disk-write-cache.sh" --serial "$SERIAL" --execute
  else
    info "Caché de escritura: no aplicable a este dispositivo."
  fi
  pcloud-volume-status >>"$LOG" 2>&1 || die "El disco no quedó listo (pcloud-volume-status)."
  ok "Disco listo: ${CAND_DESC[$PICK]}"
  DISK_OK=1
fi

# ── 10. Acceso remoto ─────────────────────────────────────────────────────────────────────────

step "Acceso desde fuera de casa (opcional)"
if [ "$TAILSCALE" = ask ]; then
  if ask_yn "¿Activar el acceso privado desde fuera de casa con Tailscale? (no abre puertos; necesita una cuenta gratuita)" n; then TAILSCALE=yes; else TAILSCALE=no; fi
fi
if [ "$TAILSCALE" = yes ]; then
  echo "+ pcloud-install-tailscale.sh --execute" >>"$LOG"
  info "Abre el enlace que aparecerá para autorizar este equipo en tu cuenta de Tailscale"
  info "(en su consola, activa también MagicDNS y «HTTPS Certificates»)."
  bash "$SETUP/pcloud-install-tailscale.sh" --execute 2>&1 | tee -a "$LOG" \
    | grep --line-buffered -E 'https://login\.tailscale\.com|^[[:space:]]*[0-9]+\.[0-9]+|Esperando|Desde Internet|sin autorizar|pcloud-install-caddy' \
    | sed -u 's/^/  /' || true
else
  info "Omitido. Se puede activar más tarde: sudo bash $SETUP/pcloud-install-tailscale.sh --execute"
fi

# ── Resumen ───────────────────────────────────────────────────────────────────────────────────

IP="$(hostname -I 2>/dev/null | awk '{ print $1 }')"
CA=/etc/caddy/pcloud-public/pcloud-ca.crt
FINGERPRINT=""
[ -r "$CA" ] && FINGERPRINT="$(openssl x509 -in "$CA" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)"
CODE=""
if curl -fsS --max-time 5 http://127.0.0.1:3000/api/v1/setup/status 2>/dev/null | grep -q '"needsOwner":true'; then
  CODE="$(runuser -u pcloud -- /usr/local/bin/node "$APP/apps/server/src/cli/admin.ts" --config "$CONFIG" setup-token 2>>"$LOG" || true)"
fi

printf '\n%s✓ Personal Cloud Storage está instalado.%s\n\n' "$G$B" "$N"
printf '  Abre en tu navegador:  %shttps://%s.local%s' "$B" "$HOST" "$N"
[ -n "$IP" ] && printf '   (o https://%s)' "$IP"
printf '\n'
if [ -n "$CODE" ]; then
  printf '  Código para crear tu cuenta:  %s%s%s   (válido 24 h, un solo uso)\n' "$B" "$CODE" "$N"
fi
printf '\n  El navegador avisará del certificado la primera vez: es la CA propia de tu nube.\n'
printf '  Para quitar el aviso, instálala en tus dispositivos desde https://%s.local/pcloud-ca.crt\n' "$HOST"
[ -n "$FINGERPRINT" ] && printf '  y comprueba que su huella SHA-256 es:\n    %s\n' "$FINGERPRINT"
if [ "$DISK_OK" -eq 0 ]; then
  printf '\n  %s!%s Sin disco de datos todavía: conecta un disco exFAT/NTFS y vuelve a ejecutar el instalador.\n' "$Y" "$N"
fi
printf '\n  %sImportante:%s esto no es una copia de seguridad. Guarda otra copia de lo que te importe.\n' "$B" "$N"
printf '  %sActualizar: vuelve a ejecutar el mismo comando. Registro: %s · Guía: docs/OPERATIONS.md%s\n\n' "$DIM" "$LOG" "$N"
