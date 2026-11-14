#!/usr/bin/env bash
# pcloud-mountpoint-guard.sh — Protege el punto de montaje para que la microSD nunca reciba
# datos cuando el HDD no está montado (spec §3.4.8).
#
#   check   (SOLO LECTURA) Comprueba el estado del mountpoint, su línea de fstab y su unidad systemd.
#   apply   Muestra el plan (DRY-RUN por defecto). Con --execute, y solo con el disco DESMONTADO
#           y el directorio VACÍO: mkdir, chown root:root, chmod 0555 y chattr +i.
#           No toca el HDD ni borra nada. Deshacer: sudo chattr -i <mountpoint>
#
# Uso:
#   bash pcloud-mountpoint-guard.sh check [--mountpoint /srv/pcloud]
#   sudo bash pcloud-mountpoint-guard.sh apply [--mountpoint /srv/pcloud]            # dry-run
#   sudo bash pcloud-mountpoint-guard.sh apply --execute [--mountpoint /srv/pcloud]
#
# Montar sobre un directorio inmutable funciona: el montaje no modifica el inodo.
# Salida de check: 0 correcto, 1 avisos, 2 peligro (hay ficheros en el mountpoint sin disco).

set -uo pipefail
export LC_ALL=C.UTF-8 2>/dev/null || export LC_ALL=C

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }
ACTION="${1:-}"; [ $# -gt 0 ] && shift
MP="/srv/pcloud" EXECUTE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mountpoint) MP="${2:-}"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Argumento desconocido: $1" >&2; exit 64 ;;
  esac
done
if ! [[ "$MP" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$MP" == */ || "$MP" == *..* || "$MP" == *//* ]]; then
  echo "Mountpoint no aceptado: '$MP' (ruta absoluta canónica, distinta de /, sin espacios ni '..')" >&2
  exit 64
fi

STATUS=0
ok()     { printf '  [OK]      %s\n' "$*"; }
warn()   { printf '  [AVISO]   %s\n' "$*"; [ "$STATUS" -lt 1 ] && STATUS=1; }
danger() { printf '  [PELIGRO] %s\n' "$*"; STATUS=2; }

check() {
  echo "== Punto de montaje $MP"
  if [ ! -e "$MP" ]; then
    warn "No existe (créalo con: sudo bash $0 apply)"
  elif mountpoint -q "$MP"; then
    ok "Montado: $(findmnt -rno SOURCE,FSTYPE,OPTIONS "$MP")"
    echo "  (con el disco montado no se puede inspeccionar el directorio subyacente de la microSD)"
  else
    echo "  No montado: inspeccionando el directorio de la microSD"
    local entries owner mode
    entries="$(find "$MP" -mindepth 1 -maxdepth 1 | wc -l)"
    if [ "$entries" -eq 0 ]; then ok "Vacío"; else
      danger "Contiene $entries entradas SIN disco montado: escrituras huérfanas en la microSD. Revisar a mano, no borrar a ciegas:"
      ls -la "$MP" | head -n 30 | sed 's/^/      /'
    fi
    owner="$(stat -c '%U:%G' "$MP")"; mode="$(stat -c '%a' "$MP")"
    [ "$owner" = "root:root" ] && ok "Propietario root:root" || warn "Propietario $owner (esperado root:root)"
    [ "$mode" = "555" ] && ok "Permisos 0555" || warn "Permisos $mode (esperado 555)"
    if command -v lsattr >/dev/null; then
      lsattr -d "$MP" 2>/dev/null | awk '{print $1}' | grep -q i && ok "Inmutable (chattr +i)" || warn "Sin atributo inmutable"
    fi
  fi

  echo "== /etc/fstab"
  local source fstype opts passno
  if [ -z "$(findmnt -s -rn -o TARGET 2>/dev/null | grep -Fx "$MP")" ]; then
    warn "Sin entrada en fstab para $MP (se añade en S0.2 tras pcloud-volume-check.sh)"
  else
    read -r source fstype opts passno <<<"$(findmnt -s -rn -o SOURCE,FSTYPE,OPTIONS,PASSNO "$MP")"
    case "$source" in UUID=*) ok "Fuente por UUID ($source)" ;; *) warn "Fuente '$source': usar UUID=, nunca /dev/sdX" ;; esac
    case "$fstype" in exfat|ntfs3|ntfs-3g) ok "Tipo $fstype" ;; ntfs) warn "Tipo 'ntfs' ambiguo (puede invocar ntfs-3g o el alias legacy de ntfs3): usar ntfs3 o ntfs-3g explícito" ;; *) warn "Tipo inesperado: $fstype" ;; esac
    [[ ",$opts," == *,nofail,* ]] && ok "nofail" || danger "Falta nofail: sin disco el arranque puede quedar en modo emergencia"
    [[ ",$opts," == *,force,* ]] && danger "Opción force: nunca forzar NTFS sucio/hibernado"
    [[ ",$opts," == *x-systemd.automount* ]] && warn "x-systemd.automount enmascara la ausencia del disco: no recomendado"
    [[ ",$opts," == *x-systemd.device-timeout* ]] || warn "Sin x-systemd.device-timeout: el arranque esperará 90 s si falta el disco"
    [ "${passno:-0}" = "0" ] && ok "pass=0 (sin reparación automática al arrancar)" || warn "pass=$passno: fsck automático podría reparar sin supervisión"
  fi

  echo "== systemd"
  local unit
  unit="$(systemd-escape -p --suffix=mount "$MP")"
  echo "  $unit: $(systemctl show -p ActiveState --value "$unit" 2>/dev/null || echo desconocido)"
  return 0
}

apply() {
  [ "$(id -u)" -eq 0 ] || { echo "apply requiere root" >&2; exit 64; }
  if mountpoint -q "$MP" 2>/dev/null; then
    echo "ABORTADO: $MP está montado. Desmonta el disco antes de proteger el directorio subyacente." >&2
    exit 3
  fi
  if [ -d "$MP" ] && [ -n "$(find "$MP" -mindepth 1 -maxdepth 1 | head -n1)" ]; then
    echo "ABORTADO: $MP no está vacío (posibles escrituras huérfanas). Revisa su contenido a mano; este script nunca borra." >&2
    exit 3
  fi
  local fs
  fs="$(stat -f -c '%T' "$(dirname "$MP")")"
  local plan=()
  [ -d "$MP" ] || plan+=("mkdir -p -- $MP")
  plan+=("chown root:root -- $MP" "chmod 0555 -- $MP")
  case "$fs" in
    ext2/ext3|ext4|xfs|btrfs) plan+=("chattr +i -- $MP") ;;
    *) echo "Aviso: el FS padre ($fs) puede no admitir chattr +i; se omite." >&2 ;;
  esac
  echo "Plan para $MP (FS padre: $fs):"
  printf '  %s\n' "${plan[@]}"
  if [ "$EXECUTE" -ne 1 ]; then
    echo "DRY-RUN: no se ha cambiado nada. Repite con --execute para aplicarlo."
    return 0
  fi
  local step
  for step in "${plan[@]}"; do
    echo "+ $step"
    # shellcheck disable=SC2086
    $step || { echo "Fallo en: $step" >&2; exit 1; }
  done
  echo "Hecho. Comprobación:"
  check
}

case "$ACTION" in
  check) check; exit "$STATUS" ;;
  apply) apply ;;
  *) usage >&2; exit 64 ;;
esac
