# ADR-0020: Reiniciar y apagar el equipo desde Ajustes

Estado: Aceptado (2026-11-15)

## Contexto

El propietario quiere reiniciar o apagar la Raspberry Pi desde la app, sin SSH. `pcloud.service` no tiene privilegios (sin sudo, sin capacidades, `NoNewPrivileges`) y así debe seguir.

## Decisión

- **Agente root mínimo**, igual que la copia de seguridad (ADR-0017) y la puerta de invitados (ADR-0018): `pcloud-power-agent.sh`, activado por `.path` sobre un buzón en `/var/lib/pcloud/power-agent/inbox`. Solo entiende `reboot` y `poweroff`, y responde con un código cerrado en `/run/pcloud-power-agent`.
- **La orden se programa 5 s después** con una unidad transitoria de systemd (`systemd-run --on-active=5s systemctl reboot|poweroff`), para que la respuesta HTTP llegue antes del corte. Si ya hay una orden programada, no se programa otra. systemd para los servicios con orden y desmonta los discos.
- **API:**
  - `GET /api/v1/system/power` devuelve `{ available }` (si el agente está instalado).
  - `POST /api/v1/system/power` (`{ action }`) devuelve 202. Solo el propietario y con la cabecera anti-CSRF. Se rechaza con 409 si hay una copia de seguridad copiando. Queda en la auditoría (`system.reboot`, `system.poweroff`).
- **Web:** en Ajustes, «Reiniciar o apagar», con confirmación. Apagar es una acción peligrosa y avisa de que la Pi no tiene botón: para encenderla hay que reconectar la alimentación, lo que desde fuera de casa no es posible.
  - Tras reiniciar, una pantalla de espera comprueba `/system/health` y recarga la página cuando el equipo vuelve.
  - Tras apagar, la pantalla indica cuándo se puede desconectar.

## Consecuencias

- Un propietario con la sesión robada podría apagar el equipo (denegación de servicio), pero no leer ni borrar más de lo que ya podría. No hay forma de encender la Pi a distancia.
- Las subidas en curso se reanudan solas al volver (ADR-0010). Una copia de seguridad interrumpida se retomaría en la siguiente sincronización, pero se evita cortarla a propósito.
