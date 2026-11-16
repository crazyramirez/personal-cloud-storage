#!/usr/bin/env bash
# pcloud-system-tuning.sh — Ajustes del sistema para un servidor 24/7.
#
# No toca discos de datos ni montajes. DRY-RUN por defecto; --execute para aplicar. Idempotente.
#
#   Wi-Fi: desactiva el ahorro de energía (brcmfmac provoca latencias y cortes en servidores).
#          Inmediato con `iw` y persistente con NetworkManager (se aplica en la próxima
#          activación de la conexión). NO reinicia la conexión: la sesión SSH no se corta.
#          Deshacer: borrar /etc/NetworkManager/conf.d/pcloud-wifi-powersave.conf y
#          ejecutar `iw dev wlan0 set power_save on`.
#
#   Nunca en suspensión: enmascara sleep/suspend/hibernate/hybrid-sleep/suspend-then-hibernate
#          (nada puede suspender el equipo, ni un programa ni una tecla) y logind ignora la
#          inactividad y las teclas de suspender. No se reinicia logind: rige desde el próximo
#          arranque; las máscaras, al instante.
#          Deshacer: `systemctl unmask <target>` y borrar /etc/systemd/logind.conf.d/pcloud-no-sleep.conf.
#
#   USB siempre despierto: regla udev que pone power/control=on en todos los dispositivos USB
#          (también los que se conecten después) y se aplica ya a los conectados. Un hub o un
#          disco en ahorro de energía tarda en responder y puede «desaparecer» bajo carga.
#          Deshacer: borrar /etc/udev/rules.d/90-pcloud-usb-awake.rules.
#
#   Registro del sistema persistente y acotado: Raspberry Pi OS lo guarda solo en memoria
#          (40-rpi-volatile-storage.conf) y se pierde al reiniciar, así que tras un cuelgue no
#          hay forma de saber qué pasó. Se guarda en la tarjeta, como mucho 50 MB y 1 mes,
#          volcando cada 5 min (pocas escrituras). Reinicia systemd-journald (no corta nada).
#          Deshacer: borrar /etc/systemd/journald.conf.d/90-pcloud-persistent.conf y
#          `systemctl restart systemd-journald`.
#
# Uso:
#   sudo bash pcloud-system-tuning.sh
#   sudo bash pcloud-system-tuning.sh --execute

set -euo pipefail

EXECUTE=0
[ "${1:-}" = "--execute" ] && EXECUTE=1
[ "$(id -u)" -eq 0 ] || { echo "Requiere root" >&2; exit 64; }

NM_CONF=/etc/NetworkManager/conf.d/pcloud-wifi-powersave.conf
NM_CONTENT='# Gestionado por pcloud-system-tuning.sh (Personal Cloud Storage).
# 2 = desactivar el ahorro de energía Wi-Fi en las conexiones que no lo fijen explícitamente.
[connection]
wifi.powersave = 2
'

SLEEP_TARGETS=(sleep.target suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target)
LOGIND_CONF=/etc/systemd/logind.conf.d/pcloud-no-sleep.conf
LOGIND_CONTENT='# Gestionado por pcloud-system-tuning.sh (Personal Cloud Storage).
# Servidor 24/7: nunca suspender ni hibernar (por inactividad, teclas o tapa).
[Login]
IdleAction=ignore
HandleSuspendKey=ignore
HandleHibernateKey=ignore
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
'

UDEV_RULE=/etc/udev/rules.d/90-pcloud-usb-awake.rules
UDEV_CONTENT='# Gestionado por pcloud-system-tuning.sh (Personal Cloud Storage).
# Ningún dispositivo USB (hubs, discos) entra en ahorro de energía.
ACTION=="add", SUBSYSTEM=="usb", TEST=="power/control", ATTR{power/control}="on"
'

JOURNAL_CONF=/etc/systemd/journald.conf.d/90-pcloud-persistent.conf
JOURNAL_CONTENT='# Gestionado por pcloud-system-tuning.sh (Personal Cloud Storage).
# Registro persistente para poder diagnosticar cuelgues y reinicios; acotado para cuidar la tarjeta.
# Va después de 40-rpi-volatile-storage.conf de Raspberry Pi OS y lo sustituye.
[Journal]
Storage=persistent
SystemMaxUse=50M
SystemKeepFree=1G
MaxRetentionSec=1month
SyncIntervalSec=5m
'

WIFI_DEVS=()
if command -v iw >/dev/null; then
  mapfile -t WIFI_DEVS < <(iw dev | awk '$1 == "Interface" { print $2 }')
fi

PLAN=()
for dev in "${WIFI_DEVS[@]}"; do
  if iw dev "$dev" get power_save 2>/dev/null | grep -q ': on'; then
    PLAN+=("runtime:$dev")
  fi
done
if [ -d /etc/NetworkManager/conf.d ] && [ "$(cat "$NM_CONF" 2>/dev/null)" != "$(printf '%s' "$NM_CONTENT")" ]; then
  PLAN+=("nmconf")
fi
for target in "${SLEEP_TARGETS[@]}"; do
  [ "$(systemctl is-enabled "$target" 2>/dev/null || true)" = masked ] || PLAN+=("mask:$target")
done
[ "$(cat "$LOGIND_CONF" 2>/dev/null)" = "$(printf '%s' "$LOGIND_CONTENT")" ] || PLAN+=("logind")
[ "$(cat "$UDEV_RULE" 2>/dev/null)" = "$(printf '%s' "$UDEV_CONTENT")" ] || PLAN+=("udev")
[ "$(cat "$JOURNAL_CONF" 2>/dev/null)" = "$(printf '%s' "$JOURNAL_CONTENT")" ] || PLAN+=("journal")
for control in /sys/bus/usb/devices/*/power/control; do
  [ -f "$control" ] || continue
  [ "$(cat "$control" 2>/dev/null)" = on ] || PLAN+=("usb:$control")
done

if [ "${#PLAN[@]}" -eq 0 ]; then
  echo "Nada que hacer."
else
  echo "Plan:"
  for item in "${PLAN[@]}"; do
    case "$item" in
      runtime:*) echo "  iw dev ${item#runtime:} set power_save off" ;;
      nmconf) echo "  escribir $NM_CONF (wifi.powersave = 2)" ;;
      mask:*) echo "  systemctl mask ${item#mask:} (nunca suspender)" ;;
      logind) echo "  escribir $LOGIND_CONF (logind ignora inactividad y teclas de suspender)" ;;
      udev) echo "  escribir $UDEV_RULE (USB siempre despierto)" ;;
      usb:*) echo "  on → ${item#usb:}" ;;
      journal) echo "  escribir $JOURNAL_CONF (registro persistente, máx. 50 MB y 1 mes) y reiniciar systemd-journald" ;;
    esac
  done
  if [ "$EXECUTE" -ne 1 ]; then
    echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."
    exit 0
  fi
  for item in "${PLAN[@]}"; do
    case "$item" in
      runtime:*) iw dev "${item#runtime:}" set power_save off ;;
      nmconf) printf '%s' "$NM_CONTENT" > "$NM_CONF"; chmod 0644 "$NM_CONF" ;;
      mask:*) systemctl mask --quiet "${item#mask:}" ;;
      logind)
        install -d -m 0755 "$(dirname "$LOGIND_CONF")"
        printf '%s' "$LOGIND_CONTENT" > "$LOGIND_CONF"
        chmod 0644 "$LOGIND_CONF"
        ;;
      udev)
        printf '%s' "$UDEV_CONTENT" > "$UDEV_RULE"
        chmod 0644 "$UDEV_RULE"
        udevadm control --reload-rules 2>/dev/null || true
        ;;
      usb:*) echo on > "${item#usb:}" 2>/dev/null || echo "  aviso: no se pudo cambiar ${item#usb:}" ;;
      journal)
        install -d -m 0755 "$(dirname "$JOURNAL_CONF")"
        printf '%s' "$JOURNAL_CONTENT" > "$JOURNAL_CONF"
        chmod 0644 "$JOURNAL_CONF"
        install -d -m 2755 -g systemd-journal /var/log/journal
        systemctl restart systemd-journald
        journalctl --flush 2>/dev/null || true
        ;;
    esac
  done
fi

for dev in "${WIFI_DEVS[@]}"; do
  echo "$dev: $(iw dev "$dev" get power_save 2>/dev/null)"
done
echo "Registro: $(journalctl --disk-usage 2>/dev/null | sed 's/^Archived and active journals take up //')"
echo "Suspensión: $(for t in "${SLEEP_TARGETS[@]}"; do printf '%s=%s ' "${t%.target}" "$(systemctl is-enabled "$t" 2>/dev/null || true)"; done)"
