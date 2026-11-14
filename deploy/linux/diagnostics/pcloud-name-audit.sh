#!/usr/bin/env bash
# pcloud-name-audit.sh — Audita nombres de ficheros incompatibles con Windows/macOS (spec §3.1).
#
# SOLO LECTURA: recorre el árbol con `find -P -xdev` (no sigue symlinks ni cruza montajes)
# y emite un informe TSV "motivo<TAB>ruta". No renombra nada.
# El fichero temporal de colisiones se crea en $TMPDIR (por defecto /tmp) y se borra al salir.
#
# Uso:
#   bash pcloud-name-audit.sh /srv/pcloud/data > nombres.tsv
#   bash pcloud-name-audit.sh /srv/pcloud --summary
#
# Limitaciones conocidas (se resolverán en el indexador Node, S1.3):
#   - las colisiones por mayúsculas solo son fiables para ASCII;
#   - no detecta diferencias de normalización Unicode (NFC/NFD);
#   - la longitud se mide en bytes UTF-8, no en unidades UTF-16 como Windows.

set -uo pipefail
export LC_ALL=C.UTF-8 2>/dev/null || export LC_ALL=C

ROOT="${1:-}"
SUMMARY=0
[ "${2:-}" = "--summary" ] && SUMMARY=1
if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
fi

TMP="$(mktemp "${TMPDIR:-/tmp}/pcloud-names.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

declare -A COUNT=()
report() { COUNT["$1"]=$(( ${COUNT["$1"]:-0} + 1 )); [ "$SUMMARY" -eq 1 ] || printf '%s\t%s\n' "$1" "$2"; }

RESERVED='^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$'
n=0
while IFS= read -r -d '' path; do
  n=$((n + 1))
  [ $((n % 20000)) -eq 0 ] && printf 'Revisadas %d entradas...\n' "$n" >&2
  name="${path##*/}"
  parent="${path%/*}"

  [ -L "$path" ] && report SYMLINK "$path"
  if [ ! -L "$path" ] && [ ! -f "$path" ] && [ ! -d "$path" ]; then report TIPO_ESPECIAL "$path"; fi
  [[ "$name" == *[\\:\*\?\"\<\>\|]* ]] && report CARACTER_PROHIBIDO "$path"
  [[ "$name" =~ [[:cntrl:]] ]] && report CARACTER_CONTROL "$path"
  [[ "$name" == *" " || "$name" == *. ]] && report TERMINA_EN_ESPACIO_O_PUNTO "$path"
  [[ "${name^^}" =~ $RESERVED ]] && report NOMBRE_RESERVADO_WINDOWS "$path"
  [ "$(printf '%s' "$name" | wc -c)" -gt 255 ] && report COMPONENTE_LARGO "$path"
  [ "${#path}" -gt 240 ] && report RUTA_LARGA_PARA_WINDOWS "$path"
  # Rutas con tab/salto de línea ya se reportan como CARACTER_CONTROL; no entran en el TSV temporal.
  [[ "$path" == *[$'\t\n']* ]] || printf '%s/%s\t%s\n' "$parent" "${name,,}" "$path" >> "$TMP"
done < <(find -P "$ROOT" -xdev -mindepth 1 \( -name .pcloud -prune \) -o -print0)

# Colisiones por mayúsculas/minúsculas dentro de un mismo directorio (awk POSIX: vale mawk o gawk).
while IFS= read -r line; do
  report COLISION_MAYUSCULAS "${line#*$'\t'}"
done < <(sort -t "$(printf '\t')" -k1,1 "$TMP" | awk -F'\t' '
  { if ($1 == prev) { if (!shown) print prevline; print $0; shown = 1 } else shown = 0; prev = $1; prevline = $0 }')

{
  printf '\nResumen (%d entradas revisadas en %s):\n' "$n" "$ROOT"
  if [ "${#COUNT[@]}" -eq 0 ]; then
    printf '  Sin problemas detectados.\n'
  else
    for key in "${!COUNT[@]}"; do printf '  %-30s %d\n' "$key" "${COUNT[$key]}"; done | sort
  fi
} >&2
