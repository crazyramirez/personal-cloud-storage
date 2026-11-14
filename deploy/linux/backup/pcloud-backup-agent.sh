#!/usr/bin/env bash
# pcloud-backup-agent.sh — Agente root MÍNIMO de la copia de seguridad (ADR-0017).
#
# pcloud.service no tiene privilegios (sin sudo, sin capacidades): no puede montar discos. Cuando
# necesita montar o desmontar el disco de copia, deja una petición en
#   /var/lib/pcloud/backup-agent/inbox/<id>.req      (una línea: «mount <UUID>» o «unmount <UUID>»)
# y systemd (pcloud-backup-agent.path) lanza este agente como root, que responde en
#   /run/pcloud-backup-agent/<id>.json               (root:pcloud 0640; pcloud no puede escribir ahí)
#
# Lo ÚNICO que sabe hacer:
#   mount   <UUID>  monta ESE sistema de archivos (exFAT o NTFS) en /srv/pcloud-backup con las mismas
#                   opciones seguras que el disco de datos (nodev,nosuid,noexec, uid/gid de pcloud).
#   unmount <UUID>  vacía cachés y desmonta /srv/pcloud-backup (perezoso si el disco ya no está).
#
# Se niega a: el disco de datos de la nube, el disco del sistema, cualquier otro tipo de sistema de
# archivos, cualquier otro punto de montaje y cualquier petición que no encaje EXACTAMENTE en el
# formato. Nunca formatea, repara ni borra nada. Nunca copia texto de la petición a la respuesta.
#
# Uso manual (diagnóstico): sudo bash pcloud-backup-agent.sh   (procesa lo pendiente y sale)

set -uo pipefail
export LC_ALL=C

INBOX=/var/lib/pcloud/backup-agent/inbox
OUTBOX=/run/pcloud-backup-agent
MP=/srv/pcloud-backup
CONFIG=/etc/pcloud/config.yaml
SVC_USER=pcloud

[ "$(id -u)" -eq 0 ] || { echo "requiere root" >&2; exit 64; }
SVC_UID="$(id -u "$SVC_USER")" || exit 1
SVC_GID="$(id -g "$SVC_USER")" || exit 1
install -d -o root -g "$SVC_GID" -m 0750 "$OUTBOX"

log() { echo "pcloud-backup-agent: $*"; }

# Respuesta: solo valores de un conjunto cerrado (código) y el id ya validado.
reply() {  # reply ID ok|error CODIGO
  local id="$1" ok="$2" code="$3" tmp
  tmp="$(mktemp "$OUTBOX/.tmp.XXXXXX")"
  printf '{"id":"%s","ok":%s,"code":"%s"}\n' "$id" "$([ "$ok" = ok ] && echo true || echo false)" "$code" >"$tmp"
  chown root:"$SVC_GID" "$tmp"
  chmod 0640 "$tmp"
  mv -f "$tmp" "$OUTBOX/$id.json"
  log "$id → $code"
}

main_uuid() {
  sed -nE "s/^[[:space:]]*expected_fs_uuid:[[:space:]]*[\"']?([0-9A-Fa-f-]{9,36})[\"']?([[:space:]].*)?\$/\1/p" "$CONFIG" 2>/dev/null | head -n1
}

# Disco físico (sin número de partición) que contiene un dispositivo de bloques.
parent_disk() {
  local pk
  pk="$(lsblk -no PKNAME "$1" 2>/dev/null | head -n1)"
  if [ -n "$pk" ]; then echo "/dev/$pk"; else echo "$1"; fi
}

mounted_source() { findmnt -rn -o SOURCE --mountpoint "$MP" 2>/dev/null | head -n1; }

do_mount() {  # do_mount ID UUID
  local id="$1" uuid="$2" dev fs main root_src root_disk current opts
  main="$(main_uuid)"
  if [ -n "$main" ] && [ "${uuid,,}" = "${main,,}" ]; then reply "$id" error REFUSED_DATA_DISK; return; fi
  dev="$(readlink -f "/dev/disk/by-uuid/$uuid" 2>/dev/null || true)"
  if [ -z "$dev" ] || [ ! -b "$dev" ]; then reply "$id" error NOT_FOUND; return; fi
  case "$dev" in /dev/sd[a-z]*|/dev/nvme*|/dev/loop[0-9]*) ;; *) reply "$id" error REFUSED_DEVICE; return ;; esac
  root_src="$(findmnt -rn -o SOURCE / 2>/dev/null | head -n1)"
  root_disk="$(parent_disk "$root_src")"
  if [ "$(parent_disk "$dev")" = "$root_disk" ]; then reply "$id" error REFUSED_SYSTEM_DISK; return; fi
  if findmnt -rn -o SOURCE | grep -qx "$dev"; then
    # Ya montado en otro sitio (p. ej. el disco de datos o un montaje manual): no se toca.
    if [ "$(mounted_source)" != "$dev" ]; then reply "$id" error BUSY_ELSEWHERE; return; fi
  fi
  fs="$(blkid -c /dev/null -s TYPE -o value "$dev" 2>/dev/null || true)"
  opts="rw,noatime,nodev,nosuid,noexec,uid=$SVC_UID,gid=$SVC_GID,fmask=0177,dmask=0077,iocharset=utf8"
  case "$fs" in
    exfat) fs=exfat; opts="$opts,errors=remount-ro" ;;
    ntfs) fs=ntfs3; opts="$opts,windows_names" ;;
    *) reply "$id" error UNSUPPORTED_FS; return ;;
  esac
  [ -d "$MP" ] || { reply "$id" error NO_MOUNTPOINT; return; }

  current="$(mounted_source)"
  if [ -n "$current" ]; then
    if [ "$current" = "$dev" ]; then
      # Ya montado: si quedó en solo lectura por errores, se informa (no se repara).
      if findmnt -rn -o OPTIONS --mountpoint "$MP" | tr ',' '\n' | grep -qx ro; then reply "$id" error READ_ONLY; else reply "$id" ok MOUNTED; fi
      return
    fi
    # Montaje obsoleto de otro disco (desconectado sin expulsar): se suelta antes.
    if ! umount "$MP" 2>/dev/null && ! umount -l "$MP" 2>/dev/null; then reply "$id" error BUSY; return; fi
  fi
  if ! timeout 90 mount -t "$fs" -o "$opts" "$dev" "$MP" 2>/dev/null; then reply "$id" error MOUNT_FAILED; return; fi
  if [ "$(mounted_source)" != "$dev" ]; then reply "$id" error MOUNT_FAILED; return; fi
  if findmnt -rn -o OPTIONS --mountpoint "$MP" | tr ',' '\n' | grep -qx ro; then reply "$id" error READ_ONLY; return; fi
  reply "$id" ok MOUNTED
}

do_unmount() {  # do_unmount ID UUID
  local id="$1" uuid="$2" current dev
  current="$(mounted_source)"
  if [ -z "$current" ]; then reply "$id" ok NOT_MOUNTED; return; fi
  dev="$(readlink -f "/dev/disk/by-uuid/$uuid" 2>/dev/null || true)"
  if [ -b "$current" ] && [ -n "$dev" ] && [ "$current" != "$dev" ]; then reply "$id" error OTHER_DISK; return; fi
  if [ -b "$current" ]; then
    sync -f "$MP" 2>/dev/null || sync
    if umount "$MP" 2>/dev/null; then reply "$id" ok UNMOUNTED; else reply "$id" error BUSY; fi
  else
    # El disco ya no está: el montaje solo existe en el kernel. Se suelta sin esperar.
    if umount -l "$MP" 2>/dev/null; then reply "$id" ok UNMOUNTED; else reply "$id" error BUSY; fi
  fi
}

[ -d "$INBOX" ] || exit 0
shopt -s nullglob
for file in "$INBOX"/*.req; do
  name="$(basename "$file" .req)"
  # Ficheros regulares con nombre válido y pequeños; nada de enlaces (los pone un usuario sin privilegios).
  if ! [[ "$name" =~ ^[a-z0-9]{8,40}$ ]] || [ -L "$file" ] || [ ! -f "$file" ]; then rm -f -- "$file"; continue; fi
  line="$(head -c 128 -- "$file" | head -n1 | tr -d '\r')"
  rm -f -- "$file"
  if [[ "$line" =~ ^(mount|unmount)\ ([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}|[0-9A-Fa-f]{16})$ ]]; then
    action="${BASH_REMATCH[1]}" uuid="${BASH_REMATCH[2]}"
    if [ "$action" = mount ]; then do_mount "$name" "$uuid"; else do_unmount "$name" "$uuid"; fi
  else
    reply "$name" error INVALID_REQUEST
  fi
done

# Respuestas que nadie recogió (más de 10 min): fuera.
find "$OUTBOX" -maxdepth 1 -type f -name '*.json' -mmin +10 -exec rm -f -- {} + 2>/dev/null || true
exit 0
