#!/usr/bin/env bash
# pcloud-onboard-volume.sh — Vincula el HDD montado con esta instalación (opción "empezar vacío").
#
#   1. Comprueba con el StorageGuardian (como pcloud) que el volumen está en NEEDS_CHECK NOT_ONBOARDED.
#   2. Como pcloud: crea .pcloud/{staging,trash,versions}, la raíz de datos y el marcador (atómico).
#   3. Como root: registra UUID, marcador y controlador en /etc/pcloud/config.yaml, solo si el
#      guardián confirma READY con esos valores (escritura atómica, conserva comentarios).
#   4. Comprueba que pcloud-volume-status (como pcloud) responde READY.
#
# Nunca formatea, borra ni sobrescribe. DRY-RUN por defecto (solo el paso 1 y el plan).
#
# Uso:
#   sudo bash pcloud-onboard-volume.sh --uuid 1A2B-3C4D [--fs-type exfat]
#   sudo bash pcloud-onboard-volume.sh --uuid 1A2B-3C4D --execute [--adopt-existing]

set -euo pipefail

APP=/opt/pcloud/current/apps/server/src/cli
CONFIG=/etc/pcloud/config.yaml
UUID="" FS_TYPE=exfat EXECUTE=0 ADOPT=()
while [ $# -gt 0 ]; do
  case "$1" in
    --uuid) UUID="${2:-}"; shift 2 ;;
    --fs-type) FS_TYPE="${2:-}"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --adopt-existing) ADOPT=(--adopt-existing); shift ;;
    *) echo "Argumento desconocido: $1" >&2; exit 64 ;;
  esac
done
die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "requiere root"
[[ "$UUID" =~ ^([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}|[0-9A-Fa-f]{16})$ ]] || die "UUID con formato no válido"
[[ "$FS_TYPE" =~ ^(exfat|ntfs3|ntfs-3g)$ ]] || die "--fs-type inválido"
[ -r "$CONFIG" ] || die "no existe $CONFIG (ejecuta pcloud-bootstrap.sh)"
command -v pcloud-volume-status >/dev/null || die "falta pcloud-volume-status (despliega una release)"

json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const k=process.argv[1].split(".");let o=v;for(const p of k)o=o==null?undefined:o[p];console.log(o===undefined?"":String(o))})' "$1"; }

echo "== 1. Estado del volumen según el guardián"
STATUS_JSON="$(pcloud-volume-status --uuid "$UUID" --fs-type "$FS_TYPE" --json || true)"
STATE="$(printf '%s' "$STATUS_JSON" | json_field state)"
CODE="$(printf '%s' "$STATUS_JSON" | json_field issues.0.code)"
EXISTING="$(printf '%s' "$STATUS_JSON" | json_field issues.0.detail.existingMarker)"
echo "  $STATE ${CODE:-}${EXISTING:+ (marcador existente: $EXISTING)}"
if [ "$STATE" = "READY" ]; then echo "Ya está vinculado y READY: nada que hacer."; exit 0; fi
[ "$STATE $CODE" = "NEEDS_CHECK NOT_ONBOARDED" ] || die "el volumen no está en estado de vinculación"
[ -z "$EXISTING" ] || [ "${#ADOPT[@]}" -gt 0 ] || die "el volumen ya tiene marcador $EXISTING: usa --adopt-existing para readoptarlo"

echo "== Plan"
echo "  como pcloud: crear .pcloud/{staging,trash,versions}, $(grep -E '^\s*root_relative:' "$CONFIG" | awk '{print $2}' || echo data)/ y el marcador"
echo "  como root:   registrar expected_fs_uuid=$UUID, volume_marker=<nuevo>, fs_type=$FS_TYPE en $CONFIG"
if [ "$EXECUTE" -ne 1 ]; then echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."; exit 0; fi

echo "== 2. Vinculación del volumen (como pcloud)"
RESULT="$(runuser -u pcloud -- /usr/local/bin/node "$APP/volume-onboard.ts" --config "$CONFIG" --uuid "$UUID" --fs-type "$FS_TYPE" "${ADOPT[@]}")"
echo "  $RESULT"
MARKER="$(printf '%s' "$RESULT" | json_field markerId)"
[[ "$MARKER" =~ ^[0-9a-f-]{36}$ ]] || die "no se obtuvo un marcador válido"

echo "== 3. Registro en la configuración (como root)"
cp -p "$CONFIG" "$CONFIG.pcloud-$(date -u +%Y%m%dT%H%M%S)"
/usr/local/bin/node "$APP/config-bind-volume.ts" --config "$CONFIG" --uuid "$UUID" --marker "$MARKER" --fs-type "$FS_TYPE"
stat -c '  %A %U:%G %n' "$CONFIG"

echo "== 4. Comprobación final (como pcloud, con la configuración instalada)"
pcloud-volume-status || die "el volumen no quedó READY"
