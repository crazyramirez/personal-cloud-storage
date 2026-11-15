#!/usr/bin/env bash
# pcloud-power-agent.sh — Agente root MÍNIMO para reiniciar o apagar el equipo desde Ajustes
# (ADR-0020).
#
# pcloud.service no tiene privilegios: no puede reiniciar el sistema. El propietario lo pide en la
# web y el servidor deja una petición en
#   /var/lib/pcloud/power-agent/inbox/<id>.req      (una línea: «reboot» o «poweroff»)
# y systemd (pcloud-power-agent.path) lanza este agente como root, que responde en
#   /run/pcloud-power-agent/<id>.json               (root:pcloud 0640)
# y programa la orden 5 s después (para que la web reciba la respuesta antes del corte).
#
# Lo ÚNICO que sabe hacer es eso: `systemctl reboot` o `systemctl poweroff`. systemd para los
# servicios con orden y desmonta los discos (el de datos y el de copia) antes de cortar. Nunca copia
# texto de la petición a la respuesta.
#
# Uso manual (diagnóstico): sudo bash pcloud-power-agent.sh   (procesa lo pendiente y sale)

set -uo pipefail
export LC_ALL=C

INBOX=/var/lib/pcloud/power-agent/inbox
OUTBOX=/run/pcloud-power-agent
SVC_USER=pcloud

[ "$(id -u)" -eq 0 ] || { echo "requiere root" >&2; exit 64; }
SVC_GID="$(id -g "$SVC_USER")" || exit 1
install -d -o root -g "$SVC_GID" -m 0750 "$OUTBOX"

log() { echo "pcloud-power-agent: $*"; }

reply() {  # reply ID ok|error CODIGO
  local id="$1" ok="$2" code="$3" tmp
  tmp="$(mktemp "$OUTBOX/.tmp.XXXXXX")"
  printf '{"id":"%s","ok":%s,"code":"%s"}\n' "$id" "$([ "$ok" = ok ] && echo true || echo false)" "$code" >"$tmp"
  chown root:"$SVC_GID" "$tmp"
  chmod 0640 "$tmp"
  mv -f "$tmp" "$OUTBOX/$id.json"
  log "$id → $code"
}

# Programa la orden en una unidad transitoria: sobrevive a que este agente termine.
schedule() {  # schedule reboot|poweroff
  systemd-run --unit="pcloud-power-$1" --description="Personal Cloud Storage: $1 pedido desde la web" \
    --on-active=5s --timer-property=AccuracySec=1s /bin/systemctl "$1" >/dev/null 2>&1
}

[ -d "$INBOX" ] || exit 0
shopt -s nullglob
DONE=0
for file in "$INBOX"/*.req; do
  name="$(basename "$file" .req)"
  if ! [[ "$name" =~ ^[a-z0-9]{8,40}$ ]] || [ -L "$file" ] || [ ! -f "$file" ]; then rm -f -- "$file"; continue; fi
  line="$(head -c 16 -- "$file" | head -n1 | tr -d '\r')"
  rm -f -- "$file"
  # Una sola orden por tanda: si llegan dos (reiniciar y apagar), vale la primera.
  if [ "$DONE" -eq 1 ]; then reply "$name" error BUSY; continue; fi
  case "$line" in
    reboot | poweroff)
      if systemctl is-active --quiet "pcloud-power-reboot.timer" || systemctl is-active --quiet "pcloud-power-poweroff.timer"; then
        reply "$name" ok ALREADY_SCHEDULED
      elif schedule "$line"; then
        DONE=1
        log "programado: $line en 5 s"
        reply "$name" ok SCHEDULED
      else
        reply "$name" error FAILED
      fi
      ;;
    *) reply "$name" error INVALID_REQUEST ;;
  esac
done

find "$OUTBOX" -maxdepth 1 -type f -name '*.json' -mmin +10 -exec rm -f -- {} + 2>/dev/null || true
exit 0
