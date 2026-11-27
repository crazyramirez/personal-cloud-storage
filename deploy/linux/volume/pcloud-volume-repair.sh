#!/usr/bin/env bash
# pcloud-volume-repair.sh — Comprueba y, si hace falta, repara el sistema de archivos del HDD de datos
# JUSTO ANTES de montarlo (ADR-0032). Así el equipo aguanta un corte de luz: al volver la corriente
# el disco se revisa solo y la nube vuelve a funcionar sin que nadie haga nada.
#
# Lo lanza systemd antes de cada montaje de /srv/pcloud (pcloud-volume-repair.service, que
# srv-pcloud.mount pide con un drop-in; lo instala pcloud-install-volume-repair.sh). También lo usa
# pcloud-volume-agent.sh cuando el kernel pone el disco en solo lectura: desmonta y vuelve a montar.
#
# Con el disco en buen estado tarda milisegundos: solo lee 2 bytes del sector de arranque.
#   exFAT: si tiene la marca «volumen sucio» (no se desmontó bien: corte de luz, desconexión, error
#          del kernel) o el agente lo pidió:
#            fsck.exfat -y -s  repara lo que encuentre (unos 5 min con 500.000 ficheros). Los datos
#                              que se quedan sin carpeta se guardan en /LOST+FOUND (fuera de la
#                              nube): nunca se descartan.
#            fsck.exfat -n     verifica que ha quedado limpio (solo si hubo que reparar).
#   NTFS:  ntfsfix -n y, si avisa de algo, ntfsfix -d (lo único que se puede arreglar desde Linux).
# Si no queda limpio, el disco se monta en SOLO LECTURA: se puede ver y descargar, nada se escribe.
#
# Nunca formatea, ni particiona, ni borra ficheros. Siempre termina con éxito para no bloquear el
# montaje. Estado para la web: /run/pcloud-volume-repair/status.json. Registro completo:
# /var/log/pcloud-volume-repair.log.
#
# Uso manual (diagnóstico): sudo bash pcloud-volume-repair.sh --dry-run   (solo dice qué haría)

set -uo pipefail
export LC_ALL=C

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
[ "$(id -u)" -eq 0 ] || { echo "requiere root" >&2; exit 64; }

CONFIG=/etc/pcloud/config.yaml
MOUNTPOINT=/srv/pcloud
STATE_DIR=/run/pcloud-volume-repair
STATUS="$STATE_DIR/status.json"
FORCE="$STATE_DIR/force"
LOG=/var/log/pcloud-volume-repair.log
SVC_GROUP=pcloud
# Margen amplio: con 500.000 ficheros en un HDD de 5 TB, una pasada tarda ~5 min.
FSCK_TIMEOUT=4h

log() { echo "pcloud-volume-repair: $*"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

STARTED=""
TRIGGER=""
STEP=""          # scan (revisar y reparar) | verify (comprobar la reparación)
STEP_STARTED=""
ESTIMATE=""      # segundos que tardó la última pasada completa (para la barra de la web)
FIXED=""         # errores corregidos según fsck
PASS_FILE=/var/lib/pcloud-volume-repair/pass-seconds
json_or_null() { if [ -n "$1" ]; then printf '%s' "$1"; else printf null; fi; }
json_str_or_null() { if [ -n "$1" ]; then printf '"%s"' "$1"; else printf null; fi; }
status() {  # status FASE RESULTADO   (RESULTADO vacío → null)
  [ "$DRY" -eq 1 ] && return 0
  local phase="$1" result="$2" finished="" tmp gid
  gid="$(getent group "$SVC_GROUP" | cut -d: -f3)"
  install -d -o root -g "${gid:-0}" -m 0750 "$STATE_DIR"
  case "$phase" in done | failed) finished="$(now)" ;; esac
  tmp="$(mktemp "$STATE_DIR/.status.XXXXXX")"
  printf '{"phase":"%s","trigger":"%s","result":%s,"startedAt":"%s","finishedAt":%s,"step":%s,"stepStartedAt":%s,"estimateSeconds":%s,"fixed":%s}
'     "$phase" "$TRIGGER" "$(json_str_or_null "$result")" "$STARTED" "$(json_str_or_null "$finished")"     "$(json_str_or_null "$STEP")" "$(json_str_or_null "$STEP_STARTED")" "$(json_or_null "$ESTIMATE")" "$(json_or_null "$FIXED")" >"$tmp"
  chown root:"${gid:-0}" "$tmp"
  chmod 0640 "$tmp"
  mv -f "$tmp" "$STATUS"
}
step() {  # step NOMBRE: pasa al paso siguiente y lo publica
  STEP="$1"
  STEP_STARTED="$(now)"
  status running ""
}

# Ejecuta una herramienta de comprobación con su salida en el registro (y en LAST_OUT). La
# herramienta ignora SIGTERM (una señal ignorada se hereda al hacer exec): si se apaga el equipo a
# mitad, systemd espera a que termine (TimeoutStopSec) en vez de cortar una reparación por la mitad.
# El trap va DENTRO de timeout, porque timeout instala sus propios manejadores y reenviaría SIGTERM.
LAST_OUT=""
run_tool() {  # run_tool CMD ARGS… → código de salida
  local out rc
  install -d -m 0750 "$STATE_DIR"
  out="$(mktemp "$STATE_DIR/.salida.XXXXXX")"
  echo "── $(now) · $*" >>"$LOG"
  timeout -s KILL "$FSCK_TIMEOUT" bash -c 'trap "" TERM INT HUP; exec "$@"' run_tool "$@" >"$out" 2>&1
  rc=$?
  cat "$out" >>"$LOG"
  echo "── código $rc" >>"$LOG"
  LAST_OUT="$(tail -c 65536 "$out")"
  rm -f -- "$out"
  return "$rc"
}

# Configuración (el mismo formato que lee pcloud-recover-volume.sh).
[ -r "$CONFIG" ] || { log "sin $CONFIG: nada que comprobar"; exit 0; }
UUID="$(sed -n 's/^[[:space:]]*expected_fs_uuid:[[:space:]]*"\{0,1\}\([0-9A-Fa-f-]*\)"\{0,1\}.*/\1/p' "$CONFIG" | head -1)"
FSTYPE="$(sed -n 's/^[[:space:]]*fs_type:[[:space:]]*\([a-z0-9-]*\).*/\1/p' "$CONFIG" | head -1)"
[[ "$UUID" =~ ^([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}|[0-9A-Fa-f]{16})$ ]] || { log "sin disco vinculado: nada que comprobar"; exit 0; }
DEVICE="/dev/disk/by-uuid/$UUID"

# El disco USB puede tardar unos segundos en aparecer al arrancar (se pone en marcha el motor).
for _ in $(seq 1 30); do [ -b "$DEVICE" ] && break; sleep 1; done
[ -b "$DEVICE" ] || { log "el disco no está conectado: no hay nada que comprobar"; exit 0; }
DEV="$(readlink -f "$DEVICE")"
if mountpoint -q "$MOUNTPOINT"; then log "$MOUNTPOINT ya está montado: no se comprueba"; exit 0; fi
if findmnt -rn -S "$DEV" >/dev/null 2>&1; then log "$DEV está montado en otro sitio: no se toca"; exit 0; fi

FORCED=0
if [ -e "$FORCE" ]; then FORCED=1; [ "$DRY" -eq 1 ] || rm -f -- "$FORCE"; fi

case "$FSTYPE" in
  exfat)
    # VolumeFlags (desplazamiento 106, little-endian): bit 1 = VolumeDirty, bit 2 = MediaFailure.
    # Linux lo marca al montar y lo borra al desmontar bien; si se va la luz, se queda puesto.
    FLAGS="$(od -An -tu2 -j106 -N2 "$DEV" 2>/dev/null | tr -d ' ')"
    if ! [[ "$FLAGS" =~ ^[0-9]+$ ]]; then log "no se puede leer el sector de arranque de $DEV: se deja al montaje"; exit 0; fi
    DIRTY=$(( (FLAGS & 6) != 0 ))
    if [ "$DIRTY" -eq 0 ] && [ "$FORCED" -eq 0 ]; then log "disco limpio (se desmontó bien)"; exit 0; fi
    if [ "$FORCED" -eq 1 ]; then TRIGGER=readonly; else TRIGGER=dirty; fi
    if [ "$DRY" -eq 1 ]; then log "DRY-RUN: se comprobaría y repararía $DEV ($TRIGGER)"; exit 0; fi
    STARTED="$(now)"
    ESTIMATE="$(cat "$PASS_FILE" 2>/dev/null)"
    [[ "$ESTIMATE" =~ ^[0-9]+$ ]] || ESTIMATE=""
    step scan
    log "comprobando y reparando $DEV ($TRIGGER): unos minutos"
    T0="$(date +%s)"
    run_tool fsck.exfat -y -s "$DEV"; RC=$?  # pcloud-lint: allow-fsck-repair (ADR-0032)
    FIXED="$(sed -n 's/.*files fixed \([0-9][0-9]*\).*/\1/p' <<<"$LAST_OUT" | tail -n1)"
    if [ "$RC" -eq 0 ] || [ "$RC" -eq 1 ]; then
      # Lo que tarda una pasada completa: la próxima vez la web puede estimar cuánto falta.
      ESTIMATE=$(( $(date +%s) - T0 ))
      install -d -o root -g root -m 0700 "$(dirname "$PASS_FILE")"
      echo "$ESTIMATE" >"$PASS_FILE"
    fi
    if [ "$RC" -eq 0 ]; then
      RESULT=clean
    elif [ "$RC" -eq 1 ]; then
      log "reparado; verificando"
      step verify
      if run_tool fsck.exfat -n "$DEV"; then RESULT=repaired; else RESULT=errors_left; fi
    elif [ "$RC" -eq 4 ]; then
      RESULT=errors_left
    else
      RESULT=io_error   # 8: error de lectura/escritura; 137: no terminó a tiempo
    fi
    ;;
  ntfs3 | ntfs-3g)
    command -v ntfsfix >/dev/null || { log "falta ntfsfix (paquete ntfs-3g): no se comprueba"; exit 0; }
    TRIGGER=dirty
    [ "$FORCED" -eq 1 ] && TRIGGER=readonly
    if [ "$DRY" -eq 1 ]; then log "DRY-RUN: se comprobaría $DEV con ntfsfix -n (y -d si avisa)"; exit 0; fi
    # ntfsfix -n solo lee unos pocos metadatos: tarda segundos, así que se hace en cada montaje.
    if run_tool ntfsfix -n "$DEV" && [ "$FORCED" -eq 0 ]; then log "disco limpio"; exit 0; fi
    STARTED="$(now)"
    step scan
    log "marcando $DEV como revisado"
    run_tool ntfsfix -d "$DEV"; RC=$?  # pcloud-lint: allow-fsck-repair (ADR-0032)
    if [ "$RC" -eq 0 ]; then RESULT=repaired; else RESULT=errors_left; fi
    ;;
  *) log "tipo $FSTYPE sin comprobación conocida"; exit 0 ;;
esac

if [ "$RESULT" = clean ] || [ "$RESULT" = repaired ]; then
  log "resultado: $RESULT"
  status done "$RESULT"
  exit 0
fi

# No ha quedado limpio: se monta en SOLO LECTURA para que se pueda seguir leyendo sin empeorarlo.
# systemd ve el montaje y da por cumplido el de srv-pcloud.mount.
log "resultado: $RESULT; se monta en solo lectura"
status failed "$RESULT"
mount -o ro "$MOUNTPOINT" || log "no se pudo montar en solo lectura"
exit 0
