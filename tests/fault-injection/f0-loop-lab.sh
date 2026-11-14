#!/usr/bin/env bash
# f0-loop-lab.sh — Laboratorio F0 sobre el KERNEL REAL con volúmenes exFAT de prueba en RAM.
#
# Crea dos imágenes exFAT pequeñas en /run/pcloud-lab (tmpfs), las asocia a dispositivos loop y
# ejecuta escenarios contra el StorageGuardian real (pcloud-volume-status, como usuario pcloud):
# montaje correcto, solo lectura, remontaje, desmontaje, disco equivocado, marcador ajeno, raíz
# de datos ausente y protección del mountpoint vacío.
#
# NUNCA toca discos reales: solo formatea ficheros imagen que crea él mismo dentro de
# /run/pcloud-lab, y solo monta en el mountpoint si no hay nada montado allí.
# La desconexión física (DEVICE_ABSENT) no se puede simular con loop: queda para F0 con hardware.
#
# Uso: sudo bash f0-loop-lab.sh [--mountpoint /srv/pcloud]

set -uo pipefail
export LC_ALL=C.UTF-8 2>/dev/null || export LC_ALL=C

MP=/srv/pcloud
[ "${1:-}" = "--mountpoint" ] && MP="${2:-}"
LAB=/run/pcloud-lab
STATUS_CMD=/usr/local/bin/pcloud-volume-status

die() { echo "ABORTADO: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || die "requiere root"
[[ "$MP" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "$MP" != *..* ]] || die "mountpoint inválido"
for tool in mkfs.exfat losetup blkid udevadm mount umount runuser node "$STATUS_CMD"; do
  command -v "$tool" >/dev/null || die "falta $tool"
done
getent passwd pcloud >/dev/null || die "falta el usuario pcloud"
mountpoint -q "$MP" && die "$MP ya está montado: este laboratorio solo se ejecuta sin el HDD montado"
[ -d "$MP" ] || die "$MP no existe (ejecuta pcloud-mountpoint-guard.sh apply)"
[ -z "$(find "$MP" -mindepth 1 -maxdepth 1 | head -n1)" ] || die "$MP no está vacío"
[ "$(stat -f -c '%T' /run)" = "tmpfs" ] || die "/run no es tmpfs"
[ ! -e "$LAB" ] || die "$LAB ya existe (¿ejecución previa interrumpida?); revísalo a mano"

LOOP_A="" LOOP_B=""
cleanup() {
  local src
  src="$(findmnt -rn -o SOURCE "$MP" 2>/dev/null || true)"
  if [ -n "$src" ] && { [ "$src" = "$LOOP_A" ] || [ "$src" = "$LOOP_B" ]; }; then umount "$MP"; fi
  for dev in "$LOOP_A" "$LOOP_B"; do [ -n "$dev" ] && losetup -d "$dev" 2>/dev/null; done
  rm -f "$LAB/lab-a.img" "$LAB/lab-b.img"
  rmdir "$LAB" 2>/dev/null
  true
}
trap cleanup EXIT

PASS=0 FAIL=0
expect() { # expect "descripción" ESTADO CÓDIGO [args extra para pcloud-volume-status]
  local desc="$1" want_state="$2" want_code="$3"; shift 3
  local out got
  out="$("$STATUS_CMD" --uuid "$UUID_A" --fs-type exfat --mountpoint "$MP" --marker "$MARKER" --json "$@" 2>/dev/null)"
  got="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);console.log(v.state+" "+(v.issues[0]?v.issues[0].code:"-"))}catch{console.log("SIN-JSON -")}})')"
  if [ "$got" = "$want_state $want_code" ]; then
    PASS=$((PASS + 1)); printf '  PASS  %-58s %s\n' "$desc" "$got"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL  %-58s esperado "%s %s", obtenido "%s"\n' "$desc" "$want_state" "$want_code" "$got"
  fi
}
as_pcloud() { runuser -u pcloud -- "$@"; }
mount_lab() { mount -t exfat -o "$1,nodev,nosuid,noexec,noatime,uid=$(id -u pcloud),gid=$(id -g pcloud),fmask=0177,dmask=0077,iocharset=utf8,errors=remount-ro" "$2" "$MP"; }

echo "== Preparando volúmenes de laboratorio en $LAB (tmpfs)"
install -d -m 0700 "$LAB"
for name in a b; do
  img="$LAB/lab-$name.img"
  truncate -s 64M "$img"
  # Formatea SOLO el fichero imagen recién creado en tmpfs.
  mkfs.exfat -L "PCLOUDLAB${name^^}" "$img" >/dev/null || die "mkfs.exfat sobre la imagen falló"
done
LOOP_A="$(losetup --find --show "$LAB/lab-a.img")"
LOOP_B="$(losetup --find --show "$LAB/lab-b.img")"
udevadm settle
UUID_A="$(blkid -c /dev/null -s UUID -o value "$LOOP_A")"
UUID_B="$(blkid -c /dev/null -s UUID -o value "$LOOP_B")"
echo "  A: $LOOP_A UUID=$UUID_A   B: $LOOP_B UUID=$UUID_B"
[ -L "/dev/disk/by-uuid/$UUID_A" ] || die "udev no creó /dev/disk/by-uuid/$UUID_A"
MARKER="$(cat /proc/sys/kernel/random/uuid)"

echo "== Escenarios"
expect "Sin montar (solo el directorio protegido)" UNAVAILABLE NOT_MOUNTED
if as_pcloud touch "$MP/escritura-huerfana" 2>/dev/null; then
  FAIL=$((FAIL + 1)); echo "  FAIL  el usuario pcloud pudo escribir en el mountpoint vacío"
else
  PASS=$((PASS + 1)); printf '  PASS  %-58s %s\n' "pcloud no puede escribir en el mountpoint vacío" "denegado"
fi

mount_lab rw "$LOOP_A"
expect "Montado A sin vincular" NEEDS_CHECK NOT_ONBOARDED --marker none
as_pcloud mkdir "$MP/.pcloud" "$MP/data"
printf 'pcloud-volume-v1 %s\n' "$MARKER" | as_pcloud tee "$MP/.pcloud/volume-id" >/dev/null
expect "Montado A vinculado" READY -
expect "Marcador configurado distinto" WRONG_VOLUME MARKER_MISMATCH --marker "$(cat /proc/sys/kernel/random/uuid)"
expect "Tipo configurado ntfs3 con montaje exfat" NEEDS_CHECK FSTYPE_UNEXPECTED --fs-type ntfs3
as_pcloud mv "$MP/data" "$MP/data.tmp"
expect "Raíz de datos ausente" NEEDS_CHECK DATA_ROOT_INVALID
as_pcloud mv "$MP/data.tmp" "$MP/data"
mount -o remount,ro "$MP"
expect "Remontado en solo lectura" READ_ONLY MOUNT_READ_ONLY
mount -o remount,rw "$MP"
expect "Remontado en lectura-escritura" READY -
umount "$MP"
expect "Desmontado" UNAVAILABLE NOT_MOUNTED
[ -z "$(find "$MP" -mindepth 1 -maxdepth 1 | head -n1)" ] && { PASS=$((PASS + 1)); printf '  PASS  %-58s %s\n' "Mountpoint vacío tras desmontar" "vacío"; } \
  || { FAIL=$((FAIL + 1)); echo "  FAIL  quedaron ficheros en el mountpoint de la microSD"; }

mount_lab rw "$LOOP_B"
expect "Otro volumen montado (A conectado)" WRONG_VOLUME SOURCE_MISMATCH
umount "$MP"
losetup -d "$LOOP_A"; LOOP_A=""
udevadm settle
mount_lab rw "$LOOP_B"
expect "Otro volumen montado (A desconectado)" WRONG_VOLUME SOURCE_MISMATCH
umount "$MP"
expect "Nada montado, A desconectado" UNAVAILABLE NOT_MOUNTED

echo "== Resultado: $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ]
