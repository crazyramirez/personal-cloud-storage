#!/usr/bin/env bash
# pcloud-ssh-hardening.sh — SSH solo con clave pública, sin root y sin contraseña.
#
# Escribe /etc/ssh/sshd_config.d/10-pcloud.conf. En sshd gana el PRIMER valor de cada opción y
# los .conf se leen en orden alfabético, así que este fichero prevalece sobre 50-cloud-init.conf
# (que activa PasswordAuthentication en Raspberry Pi OS).
#
# Protección contra quedarse fuera ("interruptor de hombre muerto"):
#   - apply se niega si el usuario no tiene ninguna clave válida en ~/.ssh/authorized_keys;
#   - valida la configuración con `sshd -t` antes de recargar;
#   - programa una REVERSIÓN AUTOMÁTICA (por defecto 180 s) que solo se cancela con `confirm`,
#     ejecutado desde una sesión NUEVA abierta con la clave. Recargar sshd no corta las sesiones abiertas.
#
# Uso:
#   sudo bash pcloud-ssh-hardening.sh status
#   sudo bash pcloud-ssh-hardening.sh apply [--user <usuario>] [--rollback-after 180]            # dry-run
#   sudo bash pcloud-ssh-hardening.sh apply --execute [--user <usuario>] [--rollback-after 180]
#   sudo bash pcloud-ssh-hardening.sh confirm      # tras comprobar el acceso con clave
#   sudo bash pcloud-ssh-hardening.sh revert       # vuelve a la configuración de la imagen

set -euo pipefail

CONF=/etc/ssh/sshd_config.d/10-pcloud.conf
TIMER=pcloud-ssh-rollback
SSH_USER="${SUDO_USER:-}"   # por defecto, quien lanza sudo
ROLLBACK_AFTER=180
EXECUTE=0

die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "requiere root"
ACTION="${1:-status}"; [ $# -gt 0 ] && shift
while [ $# -gt 0 ]; do
  case "$1" in
    --user) SSH_USER="${2:-}"; shift 2 ;;
    --rollback-after) ROLLBACK_AFTER="${2:-}"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    *) die "argumento desconocido: $1" ;;
  esac
done
[[ "$SSH_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "usuario inválido"
[[ "$ROLLBACK_AFTER" =~ ^[0-9]+$ ]] && [ "$ROLLBACK_AFTER" -ge 60 ] || die "--rollback-after debe ser >= 60"

render_conf() {
  cat <<EOF
# Gestionado por pcloud-ssh-hardening.sh (Personal Cloud Storage). No editar a mano.
# Prevalece sobre 50-cloud-init.conf: en sshd gana el primer valor de cada opción.
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
AllowUsers $SSH_USER
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
EOF
}

effective() {
  sshd -T 2>/dev/null | grep -E '^(pubkeyauthentication|authenticationmethods|passwordauthentication|kbdinteractiveauthentication|permitrootlogin|allowusers|maxauthtries|logingracetime|x11forwarding) ' | sed 's/^/  /'
}

cancel_rollback() {
  systemctl stop "$TIMER.timer" 2>/dev/null || true
  systemctl reset-failed "$TIMER.service" "$TIMER.timer" 2>/dev/null || true
}

cmd_status() {
  echo "Fichero gestionado: $([ -f "$CONF" ] && echo "$CONF (presente)" || echo 'ausente')"
  echo "Reversión automática: $(systemctl is-active "$TIMER.timer" 2>/dev/null || true)"
  echo "Configuración efectiva:"; effective
  local home keys
  home="$(getent passwd "$SSH_USER" | cut -d: -f6)"
  keys="$home/.ssh/authorized_keys"
  echo "Claves autorizadas de $SSH_USER:"
  if [ -s "$keys" ]; then ssh-keygen -l -f "$keys" | sed 's/^/  /'; else echo "  (ninguna)"; fi
}

cmd_apply() {
  getent passwd "$SSH_USER" >/dev/null || die "no existe el usuario $SSH_USER"
  local home keys
  home="$(getent passwd "$SSH_USER" | cut -d: -f6)"
  keys="$home/.ssh/authorized_keys"
  [ -s "$keys" ] && ssh-keygen -l -f "$keys" >/dev/null 2>&1 \
    || die "$SSH_USER no tiene claves válidas en $keys: se quedaría fuera. Añade una clave primero."
  echo "Claves que seguirán permitiendo el acceso:"; ssh-keygen -l -f "$keys" | sed 's/^/  /'
  echo "Contenido de $CONF:"; render_conf | sed 's/^/  /'
  echo "Reversión automática programada a los ${ROLLBACK_AFTER}s salvo 'confirm'."
  if [ "$EXECUTE" -ne 1 ]; then echo "DRY-RUN: no se ha cambiado nada. Repite con --execute."; return 0; fi

  local backup=""
  if [ -f "$CONF" ]; then backup="$(mktemp)"; cp -p "$CONF" "$backup"; fi
  render_conf > "$CONF.tmp"
  chmod 0644 "$CONF.tmp"
  mv -f "$CONF.tmp" "$CONF"
  if ! sshd -t; then
    if [ -n "$backup" ]; then mv -f "$backup" "$CONF"; else rm -f "$CONF"; fi
    die "sshd -t rechaza la configuración; se ha restaurado la anterior"
  fi
  [ -n "$backup" ] && rm -f "$backup"

  cancel_rollback
  systemd-run --quiet --unit="$TIMER" --on-active="${ROLLBACK_AFTER}s" --collect \
    /bin/sh -c "rm -f '$CONF' && systemctl reload ssh"
  systemctl reload ssh
  echo "Aplicado. Configuración efectiva:"; effective
  echo "AHORA: abre una sesión NUEVA con la clave y ejecuta 'sudo bash $0 confirm' antes de ${ROLLBACK_AFTER}s."
}

cmd_confirm() {
  [ -f "$CONF" ] || die "no hay configuración aplicada (¿ya se revirtió?)"
  cancel_rollback
  echo "Confirmado: reversión automática cancelada."
  effective
}

cmd_revert() {
  cancel_rollback
  rm -f "$CONF"
  sshd -t || die "sshd -t falla tras retirar $CONF: revisar a mano"
  systemctl reload ssh
  echo "Revertido: vuelve a regir la configuración de la imagen."
  effective
}

case "$ACTION" in
  status) cmd_status ;;
  apply) cmd_apply ;;
  confirm) cmd_confirm ;;
  revert) cmd_revert ;;
  *) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64 ;;
esac
