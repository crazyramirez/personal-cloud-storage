#!/usr/bin/env bash
# pack-release.sh — Empaqueta el workspace como release desplegable (sin node_modules ni .git).
#
# 1. Compila la web (Nuxt, SPA estática con CSP) en ESTE ordenador: la Raspberry Pi no compila
#    nada, solo sirve los ficheros generados.
# 2. Empaqueta los ficheros no ignorados por git (funciona también sin commits) más la web
#    compilada (apps/web/.output/public), un release.json con metadatos y un manifest.sha256
#    que pcloud-deploy-release.sh verifica antes de instalar.
#
# Uso: bash deploy/dev/pack-release.sh [--no-web-build] [DIRECTORIO_SALIDA]   (por defecto .releases/)
#   --no-web-build  reutiliza la web ya compilada (solo si se acaba de generar a mano).
# Imprime la ruta del .tar.gz generado en la última línea.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD_WEB=1
OUT=""
for arg in "$@"; do
  case "$arg" in
    --no-web-build) BUILD_WEB=0 ;;
    -*) echo "Opción desconocida: $arg" >&2; exit 64 ;;
    *) OUT="$arg" ;;
  esac
done
OUT="${OUT:-$ROOT/.releases}"
NAME="pcloud-$(date -u +%Y%m%dT%H%M%SZ)"
WEB_OUT=apps/web/.output/public
cd "$ROOT"

META="$(mktemp -d)"
cleanup() { rm -f "$META/release.json" "$META/manifest.sha256" "$META/web-build.log"; rmdir "$META" 2>/dev/null || true; }
trap cleanup EXIT

if [ "$BUILD_WEB" -eq 1 ]; then
  PNPM_VERSION="$(sed -n 's/.*"packageManager": *"pnpm@\([0-9][0-9.]*\).*/\1/p' package.json)"
  [ -n "$PNPM_VERSION" ] || { echo "No se pudo leer la versión de pnpm de package.json" >&2; exit 1; }
  if command -v pnpm >/dev/null 2>&1; then PNPM=(pnpm); else PNPM=(npx --yes "pnpm@$PNPM_VERSION"); fi
  echo "Compilando la web..." >&2
  if ! (cd apps/web && NUXT_TELEMETRY_DISABLED=1 "${PNPM[@]}" run generate) >"$META/web-build.log" 2>&1; then
    tail -n 30 "$META/web-build.log" >&2
    echo "La compilación de la web ha fallado: no se genera ninguna release" >&2
    exit 1
  fi
fi
for required in index.html 200.html; do
  [ -f "$WEB_OUT/$required" ] || { echo "Falta $WEB_OUT/$required: compila la web (sin --no-web-build)" >&2; exit 1; }
  grep -q 'http-equiv="Content-Security-Policy"' "$WEB_OUT/$required" \
    || { echo "$WEB_OUT/$required no lleva la CSP: la web no se generó con «pnpm run generate»" >&2; exit 1; }
done

mapfile -t FILES < <(
  git ls-files --cached --others --exclude-standard -- \
    apps packages deploy tests package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json .node-version \
    | sort -u
)
[ "${#FILES[@]}" -gt 0 ] || { echo "Nada que empaquetar" >&2; exit 1; }
for file in "${FILES[@]}"; do
  # -I: los binarios (PNG, fuentes…) no cuentan; solo ficheros de texto.
  if grep -Iq $'\r' "$file"; then echo "CRLF en $file: corrige los finales de línea antes de empaquetar" >&2; exit 1; fi
done
# La web compilada está ignorada por git (es un artefacto): se añade aparte, tal cual.
mapfile -t WEB_FILES < <(find "$WEB_OUT" -type f | sort)
[ "${#WEB_FILES[@]}" -gt 0 ] || { echo "La web compilada está vacía" >&2; exit 1; }

HEAD="$(git rev-parse --short HEAD 2>/dev/null || echo sin-commits)"
DIRTY=false
[ -n "$(git status --porcelain 2>/dev/null)" ] && DIRTY=true
cat > "$META/release.json" <<EOF
{
  "name": "$NAME",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gitHead": "$HEAD",
  "dirtyWorktree": $DIRTY,
  "files": $(( ${#FILES[@]} + ${#WEB_FILES[@]} )),
  "webFiles": ${#WEB_FILES[@]}
}
EOF
sha256sum "${FILES[@]}" "${WEB_FILES[@]}" > "$META/manifest.sha256"

TAR_OPTS=()
TAR_VERSION="$(tar --version 2>/dev/null || true)"
[[ "$TAR_VERSION" == *"GNU tar"* ]] && TAR_OPTS+=(--force-local)  # "C:/..." no es host:ruta
mkdir -p "$OUT"
tar "${TAR_OPTS[@]}" -czf "$OUT/$NAME.tar.gz" --owner=0 --group=0 \
  -C "$ROOT" "${FILES[@]}" "${WEB_FILES[@]}" -C "$META" release.json manifest.sha256

echo "Release $NAME: ${#FILES[@]} ficheros + ${#WEB_FILES[@]} de la web compilada, $(du -h "$OUT/$NAME.tar.gz" | cut -f1)"
echo "$OUT/$NAME.tar.gz"
