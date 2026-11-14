#!/usr/bin/env bash
# pcloud-share-agent.sh — Agente root MÍNIMO de la puerta de invitados (ADR-0018, ADR-0019).
#
# pcloud.service no tiene privilegios: no puede ejecutar `tailscale funnel`. Cuando cambia el
# número de enlaces activos deja una petición en
#   /var/lib/pcloud/share-agent/inbox/<id>.req      (una línea: «on» u «off»)
# y systemd (pcloud-share-agent.path) lanza este agente como root, que responde en
#   /run/pcloud-share-agent/<id>.json               (root:pcloud 0640; pcloud no puede escribir ahí)
#
# Funnel va SIEMPRE en el nodo Tailscale dedicado (pcloud-share-tailscaled.service, nombre
# <host>-compartir), nunca en el nodo de la app: así el nombre de la app no se publica en el DNS
# público y los iPhone con «Limitar seguimiento de IP» siguen pudiendo abrirla.
#
# Lo ÚNICO que sabe hacer:
#   on   conecta el nodo dedicado (si falta, devuelve el enlace para iniciar sesión) y publica con
#        Funnel, en https://<host>-compartir.<tailnet>.ts.net, el socket de la puerta de invitados.
#   off  retira esa publicación.
# En los dos casos retira cualquier Funnel en :8443 del nodo principal (versiones anteriores).
#
# Nunca publica la aplicación principal (Caddy), nunca abre puertos en el router y nunca copia
# texto de la petición a la respuesta.
#
# Uso manual (diagnóstico): sudo bash pcloud-share-agent.sh   (procesa lo pendiente y sale)

set -uo pipefail
export LC_ALL=C

INBOX=/var/lib/pcloud/share-agent/inbox
OUTBOX=/run/pcloud-share-agent
SOCKET=/var/lib/pcloud/share-agent/guest.sock
TS_SOCK=/run/pcloud-share-ts/tailscaled.sock
SVC_USER=pcloud
NODE=/usr/local/bin/node

[ "$(id -u)" -eq 0 ] || { echo "requiere root" >&2; exit 64; }
SVC_GID="$(id -g "$SVC_USER")" || exit 1
install -d -o root -g "$SVC_GID" -m 0750 "$OUTBOX"
HOST="$(hostname -s | tr '[:upper:]' '[:lower:]')"
SHARE_HOST="${HOST}-compartir"

log() { echo "pcloud-share-agent: $*"; }

# Respuesta: código de un conjunto cerrado y, como mucho, dos URL ya validadas.
reply() {  # reply ID ok|error CODIGO [URL] [ENABLE_URL]
  local id="$1" ok="$2" code="$3" url="${4:-}" enable="${5:-}" tmp extra=""
  [[ "$url" =~ ^https://[a-z0-9.-]+\.ts\.net$ ]] && extra="$extra,\"url\":\"$url\""
  [[ "$enable" =~ ^https://login\.tailscale\.com/(f/[a-z]+\?node=|a/)[A-Za-z0-9]+$ ]] && extra="$extra,\"enableUrl\":\"$enable\""
  tmp="$(mktemp "$OUTBOX/.tmp.XXXXXX")"
  printf '{"id":"%s","ok":%s,"code":"%s"%s}\n' "$id" "$([ "$ok" = ok ] && echo true || echo false)" "$code" "$extra" >"$tmp"
  chown root:"$SVC_GID" "$tmp"
  chmod 0640 "$tmp"
  mv -f "$tmp" "$OUTBOX/$id.json"
  log "$id → $code"
}

# CLI del nodo dedicado.
ts() { tailscale --socket="$TS_SOCK" "$@"; }

# Lee un campo del JSON de tailscale con node (instalado por pcloud-install-node.sh).
json_field() {  # json_field EXPRESION  (stdin: JSON; EXPRESION sobre la variable d)
  "$NODE" -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{const d=JSON.parse(s);const v=($1);process.stdout.write(v==null?'':String(v))}catch{}})"
}

status_field() { ts status --json 2>/dev/null | json_field "$1"; }
dns_name() { status_field "(d.Self&&d.Self.DNSName||'').replace(/\\.\$/,'').toLowerCase()"; }

# ¿Está publicado Funnel en <dns>:443 del nodo dedicado?
funnel_on() {  # funnel_on DNS
  [ "$(ts funnel status --json 2>/dev/null | json_field "d.AllowFunnel&&d.AllowFunnel['$1:443']===true?'yes':''")" = yes ]
}

# Versiones anteriores publicaban Funnel en :8443 del nodo principal: se retira siempre.
clean_main_node() {
  local main
  main="$(tailscale status --json 2>/dev/null | json_field "(d.Self&&d.Self.DNSName||'').replace(/\\.\$/,'').toLowerCase()")"
  [ -n "$main" ] || return 0
  if [ "$(tailscale funnel status --json 2>/dev/null | json_field "d.AllowFunnel&&d.AllowFunnel['$main:8443']===true?'yes':''")" = yes ]; then
    timeout 20 tailscale funnel --yes --https=8443 off >/dev/null 2>&1 || true
    log "retirado Funnel :8443 del nodo principal"
  fi
}

do_on() {  # do_on ID
  local id="$1" state dns out link auth
  command -v tailscale >/dev/null 2>&1 || { reply "$id" error NO_TAILSCALE; return; }
  [ -S "$TS_SOCK" ] || { reply "$id" error NO_TAILSCALE; return; }
  state="$(status_field "d.BackendState")"
  if [ "$state" != Running ]; then
    # Primera vez: el nodo dedicado tiene que unirse a la cuenta. La persona abre el enlace.
    auth="$(status_field "d.AuthURL")"
    if [ -z "$auth" ]; then
      out="$(timeout 15 tailscale --socket="$TS_SOCK" up --hostname="$SHARE_HOST" --accept-dns=false --accept-routes=false --ssh=false 2>&1)"
      state="$(status_field "d.BackendState")"
      auth="$(grep -oE 'https://login\.tailscale\.com/a/[A-Za-z0-9]+' <<<"$out" | head -n1)"
      [ -n "$auth" ] || auth="$(status_field "d.AuthURL")"
    fi
    if [ "$state" != Running ]; then
      if [ -n "$auth" ]; then reply "$id" error NEEDS_LOGIN "" "$auth"; else reply "$id" error NOT_LOGGED_IN; fi
      return
    fi
  fi
  dns="$(dns_name)"
  [[ "$dns" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$ ]] || { reply "$id" error HTTPS_DISABLED; return; }
  [ -S "$SOCKET" ] || { reply "$id" error GUEST_DOWN; return; }
  if funnel_on "$dns"; then reply "$id" ok ON "https://$dns"; return; fi
  # Si Funnel no está permitido en la cuenta, la orden imprime un enlace y espera: se corta a los 20 s.
  out="$(timeout 20 tailscale --socket="$TS_SOCK" funnel --bg --yes --https=443 "unix:$SOCKET" 2>&1)"
  if funnel_on "$dns"; then reply "$id" ok ON "https://$dns"; return; fi
  link="$(grep -oE 'https://login\.tailscale\.com/f/[a-z]+\?node=[A-Za-z0-9]+' <<<"$out" | head -n1)"
  case "$link" in
    */f/funnel\?*) reply "$id" error FUNNEL_NOT_ALLOWED "" "$link" ;;
    */f/serve\?* | */f/https\?*) reply "$id" error HTTPS_DISABLED "" "$link" ;;
    *)
      if grep -qiE 'https.*(not enabled|disabled)|certificates' <<<"$out"; then reply "$id" error HTTPS_DISABLED
      elif grep -qi 'funnel' <<<"$out" && grep -qiE 'not (enabled|allowed)|policy|nodeattr' <<<"$out"; then reply "$id" error FUNNEL_NOT_ALLOWED
      else log "salida de tailscale: $(head -c 300 <<<"$out" | tr '\n' ' ')"; reply "$id" error FAILED
      fi
      ;;
  esac
}

do_off() {  # do_off ID
  local id="$1" dns
  if ! command -v tailscale >/dev/null 2>&1 || [ ! -S "$TS_SOCK" ]; then reply "$id" ok OFF; return; fi
  dns="$(dns_name)"
  if [ -z "$dns" ] || ! funnel_on "$dns"; then reply "$id" ok OFF; return; fi
  timeout 20 tailscale --socket="$TS_SOCK" funnel --yes --https=443 off >/dev/null 2>&1 || true
  if funnel_on "$dns"; then reply "$id" error FAILED; else reply "$id" ok OFF; fi
}

[ -d "$INBOX" ] || exit 0
command -v tailscale >/dev/null 2>&1 && clean_main_node
shopt -s nullglob
for file in "$INBOX"/*.req; do
  name="$(basename "$file" .req)"
  if ! [[ "$name" =~ ^[a-z0-9]{8,40}$ ]] || [ -L "$file" ] || [ ! -f "$file" ]; then rm -f -- "$file"; continue; fi
  line="$(head -c 16 -- "$file" | head -n1 | tr -d '\r')"
  rm -f -- "$file"
  case "$line" in
    on) do_on "$name" ;;
    off) do_off "$name" ;;
    *) reply "$name" error INVALID_REQUEST ;;
  esac
done

find "$OUTBOX" -maxdepth 1 -type f -name '*.json' -mmin +10 -exec rm -f -- {} + 2>/dev/null || true
exit 0
