#!/usr/bin/env bash
# pcloud-install-caddy.sh — HTTPS en la red local: instala Caddy y publica la web y la API.
#
# No toca el HDD, /srv/pcloud, /etc/pcloud ni /var/lib/pcloud. DRY-RUN por defecto; --execute
# para aplicar. Idempotente: se puede repetir (p. ej. cuando el router cambia la IP).
#
#   1. Instala el paquete caddy del repositorio de la distribución (si falta).
#   2. Genera /etc/caddy/Caddyfile desde la plantilla de la release ACTIVA, lo valida como el
#      usuario caddy y solo entonces sustituye el anterior (queda copia en Caddyfile.anterior).
#   3. Reinicia Caddy, comprueba HTTPS de verdad (certificado + web + API) y publica el
#      certificado raíz de la CA interna en /etc/caddy/pcloud-public/pcloud-ca.crt.
#
# Nombres atendidos: por defecto <hostname>.local, <hostname> y las IPv4 actuales. Solo esos:
# cualquier otro nombre se rechaza (protección contra DNS rebinding).
#
# Uso:
#   sudo bash pcloud-install-caddy.sh                                   # muestra el plan
#   sudo bash pcloud-install-caddy.sh --execute
#   sudo bash pcloud-install-caddy.sh --names mi-nube.local,192.168.1.50 --execute
#   sudo bash pcloud-install-caddy.sh --upstream 127.0.0.1:3000 --execute
#
# Deshacer: systemctl disable --now caddy  (la web deja de publicarse; los datos no se tocan).
# Volver a la configuración anterior: copiar /etc/caddy/Caddyfile.anterior sobre Caddyfile y
# «systemctl restart caddy».

set -euo pipefail

EXECUTE=0
NAMES=""
UPSTREAM="127.0.0.1:3000"
while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --names) NAMES="${2:-}"; shift 2 ;;
    --upstream) UPSTREAM="${2:-}"; shift 2 ;;
    *) echo "Opción desconocida: $1" >&2; exit 64 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "Requiere root" >&2; exit 64; }

CURRENT=/opt/pcloud/current
TEMPLATE="$CURRENT/deploy/linux/caddy/Caddyfile.tmpl"
WEB_ROOT="$CURRENT/apps/web/.output/public"
CADDYFILE=/etc/caddy/Caddyfile
PUBLIC_DIR=/etc/caddy/pcloud-public
CA_PUBLIC="$PUBLIC_DIR/pcloud-ca.crt"
CADDY_HOME=/var/lib/caddy
CA_ROOT="$CADDY_HOME/.local/share/caddy/pki/authorities/local/root.crt"

die() { echo "ERROR: $*" >&2; exit 1; }

# ── Requisitos y valores (solo lectura) ──────────────────────────────────────────────────────
[ -f "$TEMPLATE" ] || die "la release activa no trae $TEMPLATE"
[ -f "$WEB_ROOT/index.html" ] && [ -f "$WEB_ROOT/200.html" ] || die "la release activa no trae la web compilada ($WEB_ROOT)"
[[ "$UPSTREAM" =~ ^(127\.0\.0\.1|localhost|\[::1\]):[0-9]{2,5}$ ]] || die "--upstream debe ser loopback:puerto (p. ej. 127.0.0.1:3000)"

if [ -z "$NAMES" ]; then
  HOST="$(hostname -s)"
  LIST=("$HOST.local" "$HOST")
  while IFS= read -r address; do
    [ -n "$address" ] && LIST+=("$address")
  done < <(ip -4 -o addr show scope global | awk '{ split($4, a, "/"); print a[1] }' | sort -u)
  NAMES="$(IFS=,; echo "${LIST[*]}")"
fi
IFS=, read -r -a NAME_LIST <<<"$NAMES"
[ "${#NAME_LIST[@]}" -gt 0 ] || die "no hay nombres que atender"
for name in "${NAME_LIST[@]}"; do
  [[ "$name" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || die "nombre o IP inválido: '$name'"
done
SITES="$(IFS=,; echo "${NAME_LIST[*]}")"
SITES="${SITES//,/, }"
FIRST="${NAME_LIST[0]}"

# Tailscale (acceso desde Internet por VPN): si la Pi tiene nombre *.ts.net y la cuenta tiene
# HTTPS activado, se sirve también con ese nombre y certificado válido emitido por Tailscale.
TS_BLOCK=""
TS_NAME=""
if command -v tailscale >/dev/null 2>&1; then
  TS_JSON="$(tailscale status --json 2>/dev/null || true)"
  TS_NAME="$(printf '%s' "$TS_JSON" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
names = [n for n in (d.get("CertDomains") or []) if n.endswith(".ts.net")]
print(names[0] if names else "")' 2>/dev/null || true)"
  [[ "$TS_NAME" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$ ]] || TS_NAME=""
  if [ -n "$TS_NAME" ]; then
    TS_BLOCK="# Tailscale: certificado válido de *.ts.net (lo emite tailscaled; TS_PERMIT_CERT_UID=caddy).
$TS_NAME {
	import pcloud_app
}"
  fi
fi

DESIRED="$(sed -e "s|__PCLOUD_SITES__|$SITES|" -e "s|__PCLOUD_UPSTREAM__|$UPSTREAM|" -e "s|__PCLOUD_WEB_ROOT__|$WEB_ROOT|g" "$TEMPLATE" | awk -v block="$TS_BLOCK" '$0 == "__PCLOUD_TS_SITE__" { print block; next } { print }')"
if grep -q '__PCLOUD_' <<<"$DESIRED"; then die "quedan marcadores sin sustituir en la plantilla"; fi

HAVE_CADDY=0
command -v caddy >/dev/null 2>&1 && HAVE_CADDY=1
CONFIG_CHANGED=1
[ -f "$CADDYFILE" ] && [ "$(cat "$CADDYFILE")" = "$DESIRED" ] && CONFIG_CHANGED=0
ACTIVE=0
systemctl is-active --quiet caddy 2>/dev/null && ACTIVE=1
ENABLED=0
systemctl is-enabled --quiet caddy 2>/dev/null && ENABLED=1
CA_EXPORTED=0
[ -f "$CA_ROOT" ] && cmp -s "$CA_ROOT" "$CA_PUBLIC" && CA_EXPORTED=1

# Comprueba HTTPS de extremo a extremo contra este mismo equipo, validando el certificado con la
# CA interna (sin -k): TLS + nombre + contenido.
https_get() {
  curl -sS --max-time 8 --cacert "$CA_ROOT" --connect-to "$FIRST:443:127.0.0.1:443" -o /dev/null -w '%{http_code}' "https://$FIRST$1" 2>/dev/null || true
}

PLAN=()
[ "$HAVE_CADDY" -eq 0 ] && PLAN+=("apt-get install caddy (repositorio de la distribución)")
[ "$CONFIG_CHANGED" -eq 1 ] && PLAN+=("escribir $CADDYFILE para: $SITES  →  API en $UPSTREAM")
[ "$ENABLED" -eq 0 ] && PLAN+=("systemctl enable caddy (arranque automático)")
if [ "$CONFIG_CHANGED" -eq 1 ] || [ "$ACTIVE" -eq 0 ]; then PLAN+=("systemctl restart caddy y comprobar HTTPS"); fi
[ "$CA_EXPORTED" -eq 0 ] && PLAN+=("publicar el certificado raíz de la CA interna en $CA_PUBLIC")

if [ "${#PLAN[@]}" -eq 0 ]; then
  CODE="$(https_get /)"
  [ "$CODE" = 200 ] || die "todo figura instalado pero https://$FIRST/ responde '$CODE': journalctl -u caddy -n 50"
  echo "Nada que hacer: HTTPS activo en https://$FIRST/ ($SITES)."
  exit 0
fi

echo "Plan:"
printf '  %s\n' "${PLAN[@]}"
if [ "$CONFIG_CHANGED" -eq 1 ] && [ -f "$CADDYFILE" ] && [ "$HAVE_CADDY" -eq 1 ]; then
  echo "Diferencias del Caddyfile (instalado → nuevo):"
  diff -u "$CADDYFILE" <(printf '%s\n' "$DESIRED") | sed 's/^/  /' || true
fi
if [ "$EXECUTE" -ne 1 ]; then
  echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."
  exit 0
fi

# ── Aplicar ──────────────────────────────────────────────────────────────────────────────────
if [ "$HAVE_CADDY" -eq 0 ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y --no-install-recommends caddy
fi
getent passwd caddy >/dev/null || die "el paquete caddy no ha creado el usuario caddy"

install -d -o root -g root -m 0755 "$PUBLIC_DIR"

if [ "$CONFIG_CHANGED" -eq 1 ]; then
  NEW="$CADDYFILE.nueva"
  printf '%s\n' "$DESIRED" > "$NEW"
  chown root:root "$NEW"
  chmod 0644 "$NEW"
  # Se valida como el usuario del servicio y con su HOME: si la validación crea la CA interna,
  # queda en el almacén de Caddy y no en el de root.
  if ! VALIDATION="$(runuser -u caddy -- env -u XDG_DATA_HOME -u XDG_CONFIG_HOME HOME="$CADDY_HOME" \
      caddy validate --config "$NEW" --adapter caddyfile 2>&1)"; then
    printf '%s\n' "$VALIDATION" | tail -n 20 >&2
    rm -f "$NEW"
    die "el Caddyfile generado no es válido: no se ha cambiado la configuración"
  fi
  if [ -f "$CADDYFILE" ]; then cp -p "$CADDYFILE" "$CADDYFILE.anterior"; fi
  mv -f "$NEW" "$CADDYFILE"
fi

[ "$ENABLED" -eq 0 ] && systemctl enable caddy
if [ "$CONFIG_CHANGED" -eq 1 ] || [ "$ACTIVE" -eq 0 ]; then systemctl restart caddy; fi

# La CA interna se crea en el primer arranque: se espera a que exista y a que HTTPS responda.
OK=0
for _ in $(seq 1 40); do
  if [ -f "$CA_ROOT" ] && [ "$(https_get /)" = 200 ]; then OK=1; break; fi
  sleep 1
done
if [ "$OK" -ne 1 ]; then
  echo "ERROR: https://$FIRST/ no responde 200 con un certificado válido de la CA interna" >&2
  journalctl -u caddy -n 40 --no-pager >&2 || true
  exit 1
fi

if ! cmp -s "$CA_ROOT" "$CA_PUBLIC"; then
  install -o root -g root -m 0644 "$CA_ROOT" "$CA_PUBLIC.nuevo"
  mv -f "$CA_PUBLIC.nuevo" "$CA_PUBLIC"
fi

API_CODE="$(https_get /api/v1/system/health)"
REDIRECT="$(curl -sS --max-time 5 --connect-to "$FIRST:80:127.0.0.1:80" -o /dev/null -w '%{http_code}' "http://$FIRST/" 2>/dev/null || true)"

echo "HTTPS activo: https://$FIRST/"
[ -n "$TS_NAME" ] && echo "  Desde Internet (Tailscale): https://$TS_NAME/"
echo "  Nombres atendidos: $SITES"
echo "  Web: 200 · API (/api/v1/system/health): $API_CODE · HTTP→HTTPS: $REDIRECT"
if [ "$API_CODE" != 200 ]; then
  echo "  AVISO: la API no responde a través del proxy. ¿Está en marcha pcloud.service? (pcloud-install-service.sh)"
fi
echo "  Certificado raíz (para instalarlo en tus dispositivos): https://$FIRST/pcloud-ca.crt"
if command -v openssl >/dev/null 2>&1; then
  echo "  $(openssl x509 -in "$CA_PUBLIC" -noout -fingerprint -sha256 | sed 's/^.*=/Huella SHA-256: /')"
  echo "  $(openssl x509 -in "$CA_PUBLIC" -noout -enddate | sed 's/^notAfter=/Válido hasta: /')"
fi
