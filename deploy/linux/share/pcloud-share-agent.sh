#!/usr/bin/env bash
# pcloud-share-agent.sh — Agente root MÍNIMO de la puerta de invitados (ADR-0018).
#
# pcloud.service no tiene privilegios: no puede ejecutar `tailscale funnel`. Cuando cambia el
# número de enlaces activos deja una petición en
#   /var/lib/pcloud/share-agent/inbox/<id>.req      (una línea: «on» u «off»)
# y systemd (pcloud-share-agent.path) lanza este agente como root, que responde en
#   /run/pcloud-share-agent/<id>.json               (root:pcloud 0640; pcloud no puede escribir ahí)
#
# Lo ÚNICO que sabe hacer:
#   on   publica con Tailscale Funnel, en https://<host>.<tailnet>.ts.net:8443, el socket de la
#        puerta de invitados (unix:/var/lib/pcloud/share-agent/guest.sock), que solo sirve enlaces.
#   off  retira esa publicación (solo el puerto 8443; no toca ninguna otra configuración de serve).
#
# Nunca publica la aplicación principal (Caddy, :443), nunca abre puertos en el router y nunca
# copia texto de la petición a la respuesta.
#
# Uso manual (diagnóstico): sudo bash pcloud-share-agent.sh   (procesa lo pendiente y sale)

set -uo pipefail
export LC_ALL=C

INBOX=/var/lib/pcloud/share-agent/inbox
OUTBOX=/run/pcloud-share-agent
SOCKET=/var/lib/pcloud/share-agent/guest.sock
PORT=8443
SVC_USER=pcloud
NODE=/usr/local/bin/node

[ "$(id -u)" -eq 0 ] || { echo "requiere root" >&2; exit 64; }
SVC_GID="$(id -g "$SVC_USER")" || exit 1
install -d -o root -g "$SVC_GID" -m 0750 "$OUTBOX"

log() { echo "pcloud-share-agent: $*"; }

# Respuesta: código de un conjunto cerrado y, como mucho, dos URL ya validadas.
reply() {  # reply ID ok|error CODIGO [URL] [ENABLE_URL]
  local id="$1" ok="$2" code="$3" url="${4:-}" enable="${5:-}" tmp extra=""
  [[ "$url" =~ ^https://[a-z0-9.-]+\.ts\.net:8443$ ]] && extra="$extra,\"url\":\"$url\""
  [[ "$enable" =~ ^https://login\.tailscale\.com/f/[a-z]+\?node=[A-Za-z0-9]+$ ]] && extra="$extra,\"enableUrl\":\"$enable\""
  tmp="$(mktemp "$OUTBOX/.tmp.XXXXXX")"
  printf '{"id":"%s","ok":%s,"code":"%s"%s}\n' "$id" "$([ "$ok" = ok ] && echo true || echo false)" "$code" "$extra" >"$tmp"
  chown root:"$SVC_GID" "$tmp"
  chmod 0640 "$tmp"
  mv -f "$tmp" "$OUTBOX/$id.json"
  log "$id → $code"
}

# Lee un campo del JSON de tailscale con node (instalado por pcloud-install-node.sh).
json_field() {  # json_field EXPRESION  (stdin: JSON; EXPRESION sobre la variable d)
  "$NODE" -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{const d=JSON.parse(s);const v=($1);process.stdout.write(v==null?'':String(v))}catch{}})"
}

dns_name() {
  tailscale status --json 2>/dev/null | json_field "(d.Self&&d.Self.DNSName||'').replace(/\\.\$/,'').toLowerCase()"
}

backend_state() {
  tailscale status --json 2>/dev/null | json_field "d.BackendState"
}

# ¿Está publicado Funnel en <dns>:8443?
funnel_on() {  # funnel_on DNS
  local key="$1:$PORT"
  [ "$(tailscale funnel status --json 2>/dev/null | json_field "d.AllowFunnel&&d.AllowFunnel['$key']===true?'yes':''")" = yes ]
}

do_on() {  # do_on ID
  local id="$1" state dns out link
  command -v tailscale >/dev/null 2>&1 || { reply "$id" error NO_TAILSCALE; return; }
  state="$(backend_state)"
  [ "$state" = Running ] || { reply "$id" error NOT_LOGGED_IN; return; }
  dns="$(dns_name)"
  [[ "$dns" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$ ]] || { reply "$id" error HTTPS_DISABLED; return; }
  [ -S "$SOCKET" ] || { reply "$id" error GUEST_DOWN; return; }
  if funnel_on "$dns"; then reply "$id" ok ON "https://$dns:$PORT"; return; fi
  # Si Funnel no está permitido en la cuenta, la orden imprime un enlace y espera: se corta a los 20 s.
  out="$(timeout 20 tailscale funnel --bg --yes --https="$PORT" "unix:$SOCKET" 2>&1)"
  if funnel_on "$dns"; then reply "$id" ok ON "https://$dns:$PORT"; return; fi
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
  command -v tailscale >/dev/null 2>&1 || { reply "$id" ok OFF; return; }
  dns="$(dns_name)"
  if [ -n "$dns" ] && ! funnel_on "$dns"; then reply "$id" ok OFF; return; fi
  timeout 20 tailscale funnel --yes --https="$PORT" off >/dev/null 2>&1 || true
  if [ -n "$dns" ] && funnel_on "$dns"; then reply "$id" error FAILED; else reply "$id" ok OFF; fi
}

[ -d "$INBOX" ] || exit 0
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
