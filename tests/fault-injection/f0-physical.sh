#!/usr/bin/env bash
# f0-physical.sh — Prueba F0 física: desconexión del HDD durante una escritura (spec §3.4, §15 T1-T3).
#
# Ejecutar como root, fase a fase, con el volumen VINCULADO y READY. Pensado para un disco SIN datos
# valiosos: escribe datos de prueba en <raíz de datos>/.f0-test y los borra en `cleanup`.
#
#   prepare  Vigilante del guardián (journal: pcloud-f0-watch), 3 ficheros de referencia de 256 MiB con
#            SHA-256 guardado en /run/pcloud-f0 (RAM) y verificación de READY.
#   load     Escritura continua como pcloud (pcloud-f0-load) con el protocolo de commit:
#            .part → fsync → rename → fsync del directorio, 128 MiB por fichero.
#   observe  Tras DESENCHUFAR: transiciones del guardián, errores del escritor, montaje, microSD, kernel.
#   recover  Tras ENCHUFAR: espera el dispositivo, fsck.exfat -n (solo lectura) desmontado y remonta.
#   verify   SHA-256 de los ficheros de referencia y de los completados por el escritor.
#   cleanup  Detiene las unidades y borra el directorio de prueba y /run/pcloud-f0.
#
# Uso: sudo bash f0-physical.sh <fase>

set -uo pipefail
export LC_ALL=C.UTF-8 2>/dev/null || export LC_ALL=C

MP=/srv/pcloud
STATE=/run/pcloud-f0
CONFIG=/etc/pcloud/config.yaml
die() { echo "ABORTADO: $*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || die "requiere root"
cd / || die "no se puede cambiar a /"  # runuser hereda el cwd; el home del operador no es accesible para pcloud

UUID="$(awk '$1 == "expected_fs_uuid:" { print $2 }' "$CONFIG")"
ROOT_REL="$(awk '$1 == "root_relative:" { print $2 }' "$CONFIG")"
[[ "$UUID" =~ ^[0-9A-Fa-f-]{9,36}$ ]] || die "no hay volumen vinculado en $CONFIG"
TESTDIR="$MP/${ROOT_REL:-data}/.f0-test"
UNIT="$(systemd-escape -p --suffix=mount "$MP")"
as_pcloud() { runuser -u pcloud -- "$@"; }
status_line() { pcloud-volume-status 2>&1 | head -n 2 | tr '\n' ' '; echo; }

phase_prepare() {
  pcloud-volume-status >/dev/null || die "el volumen debe estar READY: $(status_line)"
  [ ! -e "$STATE" ] || die "$STATE ya existe (¿prueba anterior sin cleanup?)"
  [ ! -e "$TESTDIR" ] || die "$TESTDIR ya existe"
  install -d -o pcloud -g pcloud -m 0700 "$STATE"
  date +%s > "$STATE/t0"
  systemctl reset-failed pcloud-f0-watch.service 2>/dev/null || true
  systemd-run --quiet --unit=pcloud-f0-watch --collect /usr/local/bin/pcloud-volume-status --watch 0.5
  as_pcloud mkdir "$TESTDIR"
  for i in 1 2 3; do
    as_pcloud bash -c "set -o pipefail; head -c 256M /dev/urandom | tee '$TESTDIR/ref-$i.bin' | sha256sum | cut -d' ' -f1 > '$STATE/ref-$i.sha' && sync '$TESTDIR/ref-$i.bin'" \
      || die "no se pudo escribir el fichero de referencia $i"
  done
  sync -f "$TESTDIR"
  echo "Referencias escritas y sincronizadas: $(ls "$TESTDIR" | tr '\n' ' ')"
  echo "Estado: $(status_line)"
  echo "Alimentación: $(vcgencmd get_throttled)"
}

phase_load() {
  [ -d "$STATE" ] || die "ejecuta antes 'prepare'"
  cat > "$STATE/writer.sh" <<EOF
#!/usr/bin/env bash
set -o pipefail
i=0
while :; do
  i=\$((i + 1)); n=\$(printf '%04d' "\$i"); f="$TESTDIR/load-\$n"; t=\$(date +%s%N)
  head -c 128M /dev/urandom | tee "\$f.part" | sha256sum | cut -d' ' -f1 > "$STATE/load-\$n.sha.tmp" || { echo "FALLO escribiendo \$f.part"; exit 1; }
  sync "\$f.part" || { echo "FALLO en fsync de \$f.part"; exit 1; }
  mv "\$f.part" "\$f" || { echo "FALLO renombrando \$f.part"; exit 1; }
  sync "$TESTDIR" || { echo "FALLO en fsync del directorio tras renombrar \$f"; exit 1; }
  mv "$STATE/load-\$n.sha.tmp" "$STATE/load-\$n.sha"
  echo "completado load-\$n en \$(( (\$(date +%s%N) - t) / 1000000 )) ms"
done
EOF
  chown pcloud:pcloud "$STATE/writer.sh"; chmod 0700 "$STATE/writer.sh"
  systemctl reset-failed pcloud-f0-load.service 2>/dev/null || true
  systemd-run --quiet --unit=pcloud-f0-load --collect --uid=pcloud --gid=pcloud /bin/bash "$STATE/writer.sh"
  sleep 8
  echo "Escritor activo: $(systemctl is-active pcloud-f0-load.service)"
  journalctl -u pcloud-f0-load.service --no-pager -o cat | tail -n 3
  echo "Alimentación durante la escritura: $(vcgencmd get_throttled)"
}

phase_observe() {
  sleep 3
  echo "== Guardián (transiciones registradas por el vigilante)"
  journalctl -u pcloud-f0-watch.service --no-pager -o short-precise | grep -E 'READY|UNAVAILABLE|WRONG|NEEDS|UNHEALTHY|READ_ONLY|    [A-Z_]+:' | tail -n 12
  echo "== Estado actual: $(status_line)"
  echo "== Escritor"
  echo "  unidad: $(systemctl is-active pcloud-f0-load.service 2>&1)"
  journalctl -u pcloud-f0-load.service --no-pager -o cat | tail -n 4 | sed 's/^/  /'
  echo "== Montaje"
  findmnt "$MP" || echo "  $MP sin montar"
  if ! mountpoint -q "$MP"; then
    echo "  Contenido del directorio de la microSD: $(ls -A "$MP" | wc -l) entradas (debe ser 0)"
  fi
  echo "  Unidad $UNIT: $(systemctl show -p ActiveState --value "$UNIT")"
  echo "== Dispositivo"
  ls -l "/dev/disk/by-uuid/$UUID" 2>&1 | sed 's/^/  /'
  echo "== Kernel"
  journalctl -k --no-pager -o short-precise --since "@$(cat "$STATE/t0")" | grep -iE 'usb [0-9-]+:|disconnect|sd[a-z]|exfat|i/o error|voltage' | tail -n 15
  echo "== Alimentación: $(vcgencmd get_throttled)"
}

phase_recover() {
  echo "== Esperando a /dev/disk/by-uuid/$UUID"
  for _ in $(seq 1 60); do [ -e "/dev/disk/by-uuid/$UUID" ] && break; sleep 1; done
  [ -e "/dev/disk/by-uuid/$UUID" ] || die "el disco no ha reaparecido en 60 s"
  DEV="$(readlink -f "/dev/disk/by-uuid/$UUID")"
  sleep 3
  echo "  reaparece como $DEV"
  echo "== Situación del montaje tras reconectar (¿remonta systemd solo?)"
  findmnt "$MP" || echo "  $MP sin montar"
  echo "  $UNIT: $(systemctl show -p ActiveState --value "$UNIT")"
  echo "  guardián: $(status_line)"
  if mountpoint -q "$MP"; then
    echo "== Desmontando para comprobar el sistema de archivos"
    systemctl stop "$UNIT" 2>/dev/null || umount "$MP" || umount -l "$MP"
  fi
  mountpoint -q "$MP" && die "no se pudo desmontar $MP"
  echo "  Contenido del directorio de la microSD: $(ls -A "$MP" | wc -l) entradas (debe ser 0)"
  echo "== fsck.exfat -n (solo lectura)"
  fsck.exfat -n "$DEV"; FSCK=$?
  echo "  fsck.exfat -n exit=$FSCK"
  echo "== Cabecera (VolumeDirty)"
  bash /opt/pcloud/current/deploy/linux/diagnostics/pcloud-volume-check.sh --uuid "$UUID" | grep -E 'VolumeDirty|MediaFailure|BLOQUEA'
  if [ "$FSCK" -ne 0 ]; then
    echo "RESULTADO: el sistema de archivos tiene inconsistencias tras la desconexión."
    echo "No se monta ni se repara automáticamente. Reparación (solo con permiso): fsck.exfat -y $DEV"
    exit 3
  fi
  echo "== Montando"
  systemctl start "$UNIT"
  sleep 2
  echo "  guardián: $(status_line)"
  journalctl -u pcloud-f0-watch.service --no-pager -o cat | grep -E '^\[' | tail -n 6
}

phase_verify() {
  pcloud-volume-status >/dev/null || die "el volumen debe estar READY: $(status_line)"
  local ok=0 bad=0 missing=0 renamed=0 name want got
  echo "== Ficheros de referencia (sincronizados antes de la desconexión)"
  for i in 1 2 3; do
    want="$(cat "$STATE/ref-$i.sha")"
    got="$(as_pcloud sha256sum "$TESTDIR/ref-$i.bin" 2>/dev/null | cut -d' ' -f1)"
    if [ -z "$got" ]; then missing=$((missing + 1)); echo "  FALTA ref-$i.bin"
    elif [ "$got" = "$want" ]; then ok=$((ok + 1)); echo "  OK    ref-$i.bin"
    else bad=$((bad + 1)); echo "  MAL   ref-$i.bin"; fi
  done
  echo "== Ficheros completados por el escritor (renombrados tras fsync)"
  for sha in "$STATE"/load-*.sha; do
    [ -e "$sha" ] || continue
    name="$(basename "$sha" .sha)"; want="$(cat "$sha")"
    got="$(as_pcloud sha256sum "$TESTDIR/$name" 2>/dev/null | cut -d' ' -f1)"
    if [ -z "$got" ]; then
      got="$(as_pcloud sha256sum "$TESTDIR/$name.part" 2>/dev/null | cut -d' ' -f1)"
      if [ "$got" = "$want" ]; then renamed=$((renamed + 1)); echo "  RENOMBRADO PERDIDO $name (contenido íntegro en $name.part)"
      elif [ -n "$got" ]; then bad=$((bad + 1)); echo "  MAL   $name.part (renombrado perdido y contenido distinto)"
      else missing=$((missing + 1)); echo "  FALTA $name"; fi
    elif [ "$got" = "$want" ]; then ok=$((ok + 1))
    else bad=$((bad + 1)); echo "  MAL   $name"; fi
  done
  echo "== Restos de la escritura interrumpida (esperado: como mucho 1 .part sin confirmar)"
  as_pcloud find "$TESTDIR" -maxdepth 1 -name '*.part' -printf '  %f %s bytes\n'
  echo "RESULTADO: $ok íntegros, $bad corruptos, $missing ausentes, $renamed renombrados perdidos"
  [ "$bad" -eq 0 ] && [ "$missing" -eq 0 ]
}

phase_cleanup() {
  systemctl stop pcloud-f0-load.service pcloud-f0-watch.service 2>/dev/null || true
  if [ -d "$TESTDIR" ] && [ "$(basename "$TESTDIR")" = ".f0-test" ] && pcloud-volume-status >/dev/null; then
    as_pcloud rm -r -- "$TESTDIR" && echo "Borrado $TESTDIR"
  fi
  rm -r -- "$STATE" 2>/dev/null && echo "Borrado $STATE"
  echo "Estado final: $(status_line)"
}

case "${1:-}" in
  prepare) phase_prepare ;;
  load) phase_load ;;
  observe) phase_observe ;;
  recover) phase_recover ;;
  verify) phase_verify ;;
  cleanup) phase_cleanup ;;
  *) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64 ;;
esac
