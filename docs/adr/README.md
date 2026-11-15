# Architecture Decision Records

Formato: Contexto → Decisión → Consecuencias → Alternativas. Un ADR aceptado no se edita: se sustituye por otro nuevo.

| # | Título | Estado |
|---|---|---|
| [0001](0001-monorepo-pnpm-typescript-nativo.md) | Monorepo pnpm y TypeScript ejecutado con type stripping de Node | Aceptado |
| [0002](0002-node-26-modulos-nativos.md) | Node 26 LTS y módulos integrados: sin dependencias con binarios nativos | Aceptado |
| [0003](0003-modelo-estados-volumen.md) | Modelo de estados del volumen y StorageGuardian que falla en cerrado | Aceptado |
| [0004](0004-identidad-volumen-y-leases.md) | Identidad del volumen: UUID + marcador + generación; leases | Aceptado |
| [0005](0005-montaje-y-mountpoint-protegido.md) | Montaje por UUID con nofail, mountpoint inmutable, servicio independiente del montaje | Aceptado |
| [0006](0006-layout-fisico-volumen.md) | `.pcloud/` en la raíz del FS; raíz administrada elegida en onboarding | Aceptado |
| [0007](0007-configuracion-estricta.md) | Configuración YAML estricta sin opciones inseguras | Aceptado |
| [0008](0008-plataforma-raspberry-pi-4b.md) | Plataforma: Raspberry Pi 4B 8 GB (sustituye a la Orange Pi Zero 2W) | Aceptado |
| [0009](0009-durabilidad-cache-y-directorios.md) | Durabilidad: vaciado de la caché del disco y fsync de directorios | Aceptado |
| [0010](0010-protocolo-subida-reanudable.md) | Protocolo de subida reanudable por offset confirmado | Aceptado |
| [0011](0011-https-lan-caddy.md) | HTTPS en la red local con Caddy y CA interna | Aceptado |
| [0012](0012-contratos-typebox.md) | Contratos de la API con TypeBox | Aceptado |
| [0013](0013-disco-que-no-responde.md) | Detección de un disco que deja de responder | Aceptado |
| [0016](0016-acceso-remoto-tailscale.md) | Acceso desde Internet por Tailscale (VPN privada, sin abrir puertos) | Aceptado |
| [0017](0017-copia-de-seguridad-disco-externo.md) | Copia de seguridad en un disco USB externo (espejo con archivo, agente root mínimo) | Aceptado |
| [0018](0018-enlaces-para-invitados.md) | Enlaces para compartir con invitados (puerta de invitados por Tailscale Funnel, solo mientras hay enlaces) | Aceptado |
| [0019](0019-nodo-tailscale-dedicado-enlaces.md) | Nodo Tailscale dedicado (`<host>-compartir`) para la puerta de invitados | Aceptado |
| [0020](0020-reiniciar-apagar-desde-la-web.md) | Reiniciar y apagar el equipo desde Ajustes (agente root mínimo) | Aceptado |

## Pendientes

| # | Tema | Sprint |
|---|---|---|
| 0014 | Política de reloj sin RTC | S1.1 (decisión D6) |
| 0015 | Remontaje tras reconexión (systemd no remonta solo) | S1.7 |
