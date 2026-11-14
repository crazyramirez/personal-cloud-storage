#!/usr/bin/env bash
# Comprobación estática de los scripts de deploy/: sintaxis bash, finales de línea LF y ausencia
# de comandos destructivos prohibidos por la spec (§3.3, §17.3).
#
# Excepción explícita y auditable: una línea que termina en `# pcloud-lint: allow-rm (motivo)`
# puede usar `rm -r` (p. ej. podar releases antiguas en /opt/pcloud). Nunca se aplica a
# formateo, particionado, dd ni reparación de sistemas de archivos.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PROHIBITED='(^|[^[:alnum:]_.-])(mkfs(\.[a-z0-9]+)?|parted|sfdisk|fdisk|wipefs|dd|shred|ntfsfix[[:space:]]+[^-]|ntfs-3g\.probe[[:space:]]+--readwrite|rm([[:space:]]+-[a-zA-Z]+)*[[:space:]]+-[a-zA-Z]*[rR][a-zA-Z]*|rm[[:space:]].*--recursive|-delete)([[:space:]]|$)'
FS_DESTRUCTIVE='(^|[^[:alnum:]_.-])(mkfs(\.[a-z0-9]+)?|parted|sfdisk|fdisk|wipefs|dd|ntfsfix[[:space:]]+[^-]|ntfs-3g\.probe[[:space:]]+--readwrite)([[:space:]]|$)'

status=0
count=0
while IFS= read -r -d '' script; do
  count=$((count + 1))
  if ! bash -n "$script"; then echo "SINTAXIS: $script"; status=1; fi
  if grep -q $'\r' "$script"; then echo "CRLF: $script"; status=1; fi
  hits="$(grep -nE "$PROHIBITED" "$script" | grep -vE '^[0-9]+:[[:space:]]*#' | grep -v 'pcloud-lint: allow-rm')"
  hits+="$(grep -nE "$FS_DESTRUCTIVE" "$script" | grep -vE '^[0-9]+:[[:space:]]*#' | grep 'pcloud-lint: allow-rm')"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
    echo "COMANDO PROHIBIDO en $script"
    status=1
  fi
  if command -v shellcheck >/dev/null; then shellcheck -S warning "$script" || status=1; fi
done < <(find . -name '*.sh' -print0)

# Los scripts de laboratorio (tests/) formatean imágenes de prueba a propósito: solo sintaxis y LF.
while IFS= read -r -d '' script; do
  count=$((count + 1))
  if ! bash -n "$script"; then echo "SINTAXIS: $script"; status=1; fi
  if grep -q $'\r' "$script"; then echo "CRLF: $script"; status=1; fi
done < <(find ../tests -name '*.sh' -print0 2>/dev/null)

[ "$status" -eq 0 ] && echo "Scripts OK ($count)"
exit "$status"
