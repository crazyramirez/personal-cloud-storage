#!/usr/bin/env bash
# pcloud-inventory.sh — Inventario de hardware y sistema para Personal Cloud Storage (FASE 0).
#
# SOLO LECTURA. No monta, no desmonta, no formatea, no repara, no escribe en discos ni
# modifica configuración. La única salida es el informe Markdown por stdout.
#
# Uso:
#   bash pcloud-inventory.sh > inventario.md            # sin privilegios
#   sudo bash pcloud-inventory.sh > inventario.md       # recomendado: más detalle (kernel log, blkid)
#   sudo bash pcloud-inventory.sh --smart > inv.md      # añade smartctl -i/-H en discos USB (ver aviso)
#
# AVISO --smart: algunos puentes USB-SATA baratos se cuelgan o resetean el bus al recibir
# comandos SAT. Ejecutarlo solo sin transferencias en curso. Por eso no está activo por defecto.
#
# El informe puede contener números de serie, MACs e IPs: revísalo antes de compartirlo.

set -uo pipefail
export LC_ALL=C.UTF-8 2>/dev/null || export LC_ALL=C

WITH_SMART=0
usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }
for arg in "$@"; do
  case "$arg" in
    --smart) WITH_SMART=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Argumento desconocido: $arg" >&2; usage >&2; exit 64 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }
section() { printf '\n## %s\n\n' "$1"; }

# run "Título" comando args...   — ejecuta un comando concreto (sin shell intermedio)
run() {
  local title="$1"; shift
  printf '### %s\n\n```text\n$ %s\n' "$title" "$*"
  if have "$1"; then
    "$@" 2>&1 | head -n 300
    printf '[exit=%s]\n' "${PIPESTATUS[0]}"
  else
    printf '(no disponible: %s)\n' "$1"
  fi
  printf '```\n\n'
}

# runsh "Título" 'tubería de solo lectura'
runsh() {
  local title="$1" script="$2"
  printf '### %s\n\n```text\n$ %s\n' "$title" "$script"
  bash -c "$script" 2>&1 | head -n 300
  printf '```\n\n'
}

# Decodifica vcgencmd get_throttled (Raspberry Pi).
decode_throttled() {
  local raw value
  raw="$(vcgencmd get_throttled 2>/dev/null | sed -n 's/^throttled=//p')"
  [ -n "$raw" ] || { echo "vcgencmd no devuelve get_throttled"; return; }
  value=$((raw))
  echo "throttled=$raw"
  [ "$value" -eq 0 ] && { echo "OK: sin subtensión ni limitación desde el arranque"; return; }
  (( value & 0x1 ))     && echo "AHORA: SUBTENSIÓN (fuente/cable insuficiente)"
  (( value & 0x2 ))     && echo "AHORA: frecuencia ARM limitada"
  (( value & 0x4 ))     && echo "AHORA: throttling activo"
  (( value & 0x8 ))     && echo "AHORA: límite térmico suave"
  (( value & 0x10000 )) && echo "DESDE ARRANQUE: hubo SUBTENSIÓN  <-- riesgo para el HDD"
  (( value & 0x20000 )) && echo "DESDE ARRANQUE: hubo limitación de frecuencia"
  (( value & 0x40000 )) && echo "DESDE ARRANQUE: hubo throttling"
  (( value & 0x80000 )) && echo "DESDE ARRANQUE: se alcanzó el límite térmico suave"
  return 0
}

printf '# Inventario Personal Cloud Storage\n\n'
printf -- '- Fecha (UTC): %s\n- Ejecutado como: %s (uid=%s)\n- Script: pcloud-inventory.sh (solo lectura)\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(id -un)" "$(id -u)"
[ "$(id -u)" -eq 0 ] || printf '\n> Sin root: algunas secciones (registro del kernel, blkid, SMART) saldrán incompletas.\n'

section "1. Placa, sistema operativo y kernel"
runsh "Modelo de placa (device tree)" "tr -d '\\0' < /proc/device-tree/model; echo"
run "Kernel" uname -a
runsh "Arquitectura kernel vs userland (Node 26 exige userland de 64 bits: arm64 o amd64)" \
  "echo \"kernel: \$(uname -m)\"; echo \"userland (dpkg): \$(dpkg --print-architecture 2>/dev/null || echo desconocido)\"; echo \"LONG_BIT: \$(getconf LONG_BIT)\""
run "Distribución" cat /etc/os-release
runsh "systemd" "systemctl --version | head -n 2"
run "Tiempo de actividad" uptime
runsh "Firmware/bootloader Raspberry Pi (solo consulta)" \
  "command -v rpi-eeprom-update >/dev/null && rpi-eeprom-update || echo 'rpi-eeprom-update no disponible'"

section "2. CPU, memoria, temperatura y alimentación"
run "CPU" lscpu
runsh "Extensiones criptográficas (aceleración SHA-256)" "grep -m1 -iE '^(Features|flags)' /proc/cpuinfo"
run "Memoria" free -h
run "Swap" swapon --show
run "zram" zramctl
runsh "Temperaturas" "for z in /sys/class/thermal/thermal_zone*; do [ -r \"\$z/temp\" ] && echo \"\$(cat \"\$z/type\"): \$(( \$(cat \"\$z/temp\") / 1000 )) °C\"; done"
if have vcgencmd; then
  printf '### Subtensión / throttling (vcgencmd get_throttled)\n\n```text\n'
  decode_throttled
  printf '```\n\n'
  runsh "Temperatura y tensión del SoC" "vcgencmd measure_temp; vcgencmd measure_volts core"
else
  printf '### Subtensión / throttling\n\n```text\nvcgencmd no disponible (no es Raspberry Pi o falta libraspberrypi-bin)\n```\n\n'
fi

section "3. Soporte de sistemas de archivos"
runsh "Sistemas de archivos registrados" "grep -E 'exfat|ntfs|fuse' /proc/filesystems || echo 'ninguno de exfat/ntfs/fuse registrado todavía (puede ser módulo sin cargar)'"
runsh "Módulos del kernel disponibles" "for m in exfat ntfs3 ntfs fuse uas usb_storage; do printf '%-12s ' \"\$m\"; modinfo -n \"\$m\" 2>/dev/null || echo '(no encontrado)'; done"
runsh "Configuración del kernel" "{ zcat /proc/config.gz 2>/dev/null || cat /boot/config-\$(uname -r) 2>/dev/null; } | grep -E 'CONFIG_(EXFAT_FS|EXFAT_DEFAULT_IOCHARSET|NTFS3_FS|NTFS3_LZX_XPRESS|NTFS3_FS_POSIX_ACL|NTFS_FS|FUSE_FS|USB_UAS)[= ]' || echo 'configuración del kernel no accesible'"
runsh "Helpers de montaje (pueden secuestrar -t exfat/-t ntfs)" "ls -l /sbin/mount.* /usr/sbin/mount.* 2>/dev/null | grep -Ei 'exfat|ntfs|fuse' || echo 'sin helpers exfat/ntfs'"
runsh "Paquetes de herramientas" "dpkg-query -W -f='\${Package} \${Version}\\n' exfatprogs exfat-fuse exfat-utils ntfs-3g smartmontools hdparm udisks2 2>&1"

section "4. USB"
run "Dispositivos USB" lsusb
run "Topología USB (driver uas/usb-storage y velocidad 480M/5000M)" lsusb -t
runsh "Autosuspend USB" "echo \"usbcore.autosuspend=\$(cat /sys/module/usbcore/parameters/autosuspend 2>/dev/null)\""
run "Línea de arranque del kernel (quirks usb-storage)" cat /proc/cmdline
runsh "cmdline.txt / config.txt (Raspberry Pi)" "for f in /boot/firmware/cmdline.txt /boot/cmdline.txt; do [ -r \"\$f\" ] && { echo \"== \$f\"; cat \"\$f\"; }; done; for f in /boot/firmware/config.txt /boot/config.txt; do [ -r \"\$f\" ] && { echo \"== \$f (líneas activas)\"; grep -vE '^\\s*(#|\$)' \"\$f\"; }; done; true"

section "5. Discos y particiones"
run "Bloques" lsblk -o NAME,SIZE,TYPE,FSTYPE,FSVER,UUID,LABEL,PTTYPE,PARTTYPENAME,MOUNTPOINTS,MODEL,TRAN,ROTA,RO,RM,HOTPLUG
if [ "$(id -u)" -eq 0 ]; then
  run "blkid (sin caché, solo lectura)" blkid -c /dev/null
fi
runsh "Detalle de discos (cola, planificador, rotacional)" "for d in /sys/block/sd*; do [ -e \"\$d\" ] || continue; n=\$(basename \"\$d\"); echo \"== \$n modelo=\$(cat \$d/device/model 2>/dev/null | xargs) rotacional=\$(cat \$d/queue/rotational) planificador=\$(cat \$d/queue/scheduler) max_sectors_kb=\$(cat \$d/queue/max_sectors_kb)\"; done"
runsh "Tarjeta microSD del sistema" "for d in /sys/block/mmcblk*/device; do [ -e \"\$d\" ] || continue; echo \"== \$d nombre=\$(cat \$d/name 2>/dev/null) fecha=\$(cat \$d/date 2>/dev/null) manfid=\$(cat \$d/manfid 2>/dev/null) oemid=\$(cat \$d/oemid 2>/dev/null)\"; done"
run "Espacio" df -hT -x tmpfs -x devtmpfs -x squashfs
runsh "Automontaje de escritorio (udisks2)" "systemctl is-active udisks2 2>&1; ls -la /media 2>/dev/null"

section "6. Montajes y fstab"
run "fstab" cat /etc/fstab
run "Verificación de fstab (solo lectura)" findmnt --verify --verbose
run "Montajes reales" findmnt --real -o TARGET,SOURCE,FSTYPE,OPTIONS
runsh "Punto de montaje previsto /srv/pcloud" "if mountpoint -q /srv/pcloud 2>/dev/null; then echo MONTADO; findmnt /srv/pcloud; elif [ -d /srv/pcloud ]; then echo 'NO montado; contenido del directorio de la microSD:'; ls -la /srv/pcloud; command -v lsattr >/dev/null && lsattr -d /srv/pcloud; else echo 'no existe'; fi"
runsh "Unidades .mount de systemd" "systemctl list-units --type=mount --all --no-pager --plain | grep -vE '^(sys|proc|dev|run)-' | head -n 60"

section "7. Red"
run "Interfaces" ip -br address
run "Enlace" ip -br link
run "Rutas" ip route
runsh "Velocidad de enlace" "for n in /sys/class/net/*; do i=\$(basename \$n); [ \"\$i\" = lo ] && continue; echo \"\$i: \$(cat \$n/speed 2>/dev/null || echo '?') Mb/s, duplex=\$(cat \$n/duplex 2>/dev/null || echo '?'), mtu=\$(cat \$n/mtu)\"; done"
runsh "Wi-Fi" "command -v iw >/dev/null && { iw dev; for w in \$(iw dev | awk '/Interface/ {print \$2}'); do iw dev \$w link; done; } || echo 'iw no disponible'"
run "Puertos a la escucha" ss -tulpn
run "Reloj y NTP (no hay RTC: la hora depende de la red)" timedatectl

section "8. Software y servicios"
runsh "Node / npm / pnpm" "node --version 2>&1; npm --version 2>&1; pnpm --version 2>&1; true"
runsh "Proxy TLS candidato" "command -v caddy nginx 2>&1; true"
run "Unidades fallidas" systemctl --failed --no-pager
runsh "Usuario de servicio pcloud" "getent passwd pcloud || echo 'no existe (se creará en S0.2)'; getent group pcloud || true"

section "9. Errores recientes de USB/disco/alimentación (arranque actual)"
runsh "Registro del kernel filtrado" "journalctl -k -b --no-pager -o short-monotonic 2>/dev/null | grep -iE 'usb [0-9-]+:|uas|usb-storage|sd[a-z]+|exfat|ntfs|i/o error|reset|voltage|under-voltage|blk_update|buffer i/o|remount' | tail -n 120 || dmesg 2>/dev/null | tail -n 120"

if [ "$WITH_SMART" -eq 1 ]; then
  section "10. SMART (opcional, discos USB)"
  if have smartctl; then
    for disk in $(lsblk -dno NAME,TRAN | awk '$2=="usb"{print $1}'); do
      run "smartctl -i /dev/$disk" smartctl -d sat -i "/dev/$disk"
      run "smartctl -H /dev/$disk" smartctl -d sat -H "/dev/$disk"
    done
  else
    printf 'smartctl no instalado (paquete smartmontools).\n'
  fi
fi

printf '\n---\nFin del inventario. Ningún dato ni configuración ha sido modificado.\n'
