# AGENTS.md — instrucciones para asistentes de IA

Este fichero es para agentes con acceso a una terminal (Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot…). Explica cómo **instalar y configurar Personal Cloud Storage de principio a fin** en el servidor de una persona y cómo trabajar en el código. `CLAUDE.md` y `GEMINI.md` solo apuntan aquí.

Si no tienes el repositorio clonado, este mismo fichero está en
`https://raw.githubusercontent.com/crazyramirez/personal-cloud-storage/main/AGENTS.md`.

Habla con la persona en su idioma y sin jerga: la mayoría no es técnica.

## 1. Reglas que no se negocian

1. **Nunca formatees, particiones, repares ni borres nada de un disco** (`mkfs`, `parted`, `fdisk`, `wipefs`, `dd`, `fsck` sin `-n`, `ntfsfix` sin `-n`, `rm -r` sobre `/srv/pcloud`…). Ni aunque te lo parezca necesario. Si el disco no es exFAT/NTFS, explica cómo formatearlo desde Windows o macOS **y que eso borra lo que contiene**, y deja que lo haga la persona.
2. **No elijas el disco por tu cuenta.** Muestra los discos compatibles (tamaño, etiqueta, modelo) y espera a que la persona confirme uno. Solo te ahorras la pregunta si ya te dio el UUID.
3. **Nunca pidas ni escribas contraseñas** (la del sistema, la de `sudo`, la de la cuenta web). Si hace falta `sudo` con contraseña, la persona ejecuta el comando en su propia terminal (§2.3).
4. **Nunca expongas el servidor a Internet**: nada de abrir puertos en el router, `tailscale funnel`, `tailscale serve`, túneles (ngrok, cloudflared) ni proxies públicos. Fuera de casa solo se entra por Tailscale ([ADR-0016](docs/adr/0016-acceso-remoto-tailscale.md)). Única excepción: la puerta de invitados de los enlaces para compartir ([ADR-0018](docs/adr/0018-enlaces-para-invitados.md)). La enciende y apaga la propia app (`pcloud-share-agent`) solo mientras hay enlaces activos; tú no la actives a mano.
5. **El código de configuración es un secreto**: dáselo a la persona en la conversación y en ningún otro sitio (ni ficheros, ni commits, ni memorias, ni servicios externos).
6. **El repositorio es público**: no escribas en él IPs, nombres de equipo, UUIDs, números de serie, nombres de tailnet ni rutas personales. Usa los marcadores de [docs/OPERATIONS.md](docs/OPERATIONS.md) (`<host>`, `<ip>`, `<UUID>`…).
7. No hagas cambios en el sistema fuera de lo que hace `install.sh` y los scripts de `deploy/linux/setup/` (todos idempotentes y con dry-run). Si algo falla, diagnostica; no improvises arreglos con `sudo`.
8. No actualices el sistema operativo (`apt full-upgrade`) ni endurezcas SSH (`pcloud-ssh-hardening.sh`) sin que la persona lo pida: pueden dejarla sin acceso.

## 2. Instalar en un servidor

Resultado esperado: la nube funcionando en `https://<host>.local` con el disco vinculado, y la persona con la dirección y el código para crear su cuenta.

Requisitos (los comprueba `--check`): Linux de 64 bits (arm64 o amd64) con systemd y apt — Debian 12+, Ubuntu 24.04+ o Raspberry Pi OS 64-bit —, fuera de contenedores, con Internet, y un disco USB **ya formateado** en exFAT o NTFS. Windows y macOS no sirven como servidor.

### 2.1 Dónde se ejecutan los comandos

- **El agente corre en el propio servidor:** ejecuta los comandos tal cual.
- **El agente corre en otro ordenador** (lo normal): por SSH. Pide a la persona `usuario@equipo` (p. ej. `pi@raspberrypi.local`) si no lo sabes y prueba:
  ```bash
  ssh -o BatchMode=yes -o ConnectTimeout=10 usuario@equipo 'echo ok'
  ```
  - Funciona → antepón `ssh usuario@equipo '…'` a cada comando del servidor.
  - Pide contraseña o falla la clave → guía a la persona para crear una clave (`ssh-keygen -t ed25519`) y copiarla (`ssh-copy-id usuario@equipo`) **en su terminal**; tú no tecleas contraseñas.
  - `Host key verification failed` o primera conexión → que la persona conecte una vez a mano (`ssh usuario@equipo`) y acepte la huella. No uses `StrictHostKeyChecking=no`.
  - No resuelve `equipo.local` → pide la IP (en el router o en la pantalla del equipo).

En lo que sigue, `S` significa «en el servidor» (directamente o por SSH).

### 2.2 Diagnóstico (solo lectura, sin root)

```bash
S: curl -fsSL https://raw.githubusercontent.com/crazyramirez/personal-cloud-storage/main/install.sh | bash -s -- --check
```

(Con el repositorio clonado en el servidor: `bash install.sh --check`.) No cambia nada. Imprime `clave=valor`:

| Clave | Qué mirar |
|---|---|
| `system.supported` | `yes` para seguir. Si `no`, `system.problems` dice por qué (32 bits → reinstalar Raspberry Pi OS **64-bit**; contenedor → instalar en el equipo real) |
| `system.internet` | `no` → sin conexión a GitHub: resolverlo antes |
| `system.sudo_nopasswd` | `yes` → puedes ejecutar el instalador tú. `no` → lo ejecuta la persona (§2.3) |
| `system.memory_mb`, `system.root_free_mb` | < 900 MB de RAM funciona justo. Con poco espacio libre en el disco del sistema (unos pocos GB; los visores ocupan ~700 MB) la instalación puede fallar |
| `system.throttled` | Solo Raspberry Pi. Distinto de `0x0` → **alimentación insuficiente**: avisa (fuente oficial, no power bank; hub con alimentación para discos exigentes) antes de seguir |
| `pcloud.installed`, `pcloud.release` | Si ya está instalado, reinstalar = actualizar (idempotente) |
| `pcloud.health`, `pcloud.needs_owner`, `pcloud.mounted`, `pcloud.volume_state` | Estado de una instalación existente |
| `disks.count`, `disk.N.*` | Discos exFAT/NTFS conectados (sin contar el del sistema): `device`, `uuid`, `fs`, `size`, `label`, `model`, `transport`, `mountpoint`, `used_by_pcloud` |

`disks.count=0` → no hay disco compatible: pide que lo conecte (en la Raspberry Pi, a un puerto USB 3 azul) y repite. Si el disco existe pero no sale, probablemente no es exFAT/NTFS (regla 1). También se puede instalar sin disco (`--no-disk`) y añadirlo luego repitiendo la instalación.

### 2.3 Decisiones con la persona

Pregunta solo esto, con estos valores por defecto:

1. **Disco** (obligatorio si hay alguno): lista `disk.N` en lenguaje llano («disco de 5 TB, exFAT, “MI-DISCO”, Seagate») y confirma. Avisa de que **no se borra nada**: se crean las carpetas `data` (la nube) y `.pcloud` (uso interno), y lo que ya había queda en el disco, fuera de la nube. Si `used_by_pcloud=yes`, se reutiliza con sus datos.
2. **Visores** de vídeo y documentos de Office (ffmpeg + LibreOffice, ~700 MB): sí por defecto.
3. **Acceso desde fuera de casa** con Tailscale: no por defecto. Requiere cuenta gratuita de Tailscale y la app en cada dispositivo.

**`sudo`:** si `system.sudo_nopasswd=yes`, ejecuta tú el instalador. Si es `no`, dale a la persona el comando exacto de §2.4 para que lo pegue en su terminal (SSH interactivo o teclado del equipo), espera a que termine y continúa en §2.5. Nunca uses `sudo -S` ni le pidas la contraseña.

### 2.4 Instalación

Siempre sin preguntas (`--yes`) y con todas las decisiones explícitas:

```bash
S: curl -fsSL https://raw.githubusercontent.com/crazyramirez/personal-cloud-storage/main/install.sh \
     | sudo bash -s -- --yes --disk <UUID> --viewers --no-tailscale
```

- `--disk <UUID>` | `--no-disk`; `--viewers` | `--no-viewers`; `--tailscale` | `--no-tailscale`.
- Con `--yes` y varios discos sin `--disk`, no vincula ninguno: pasa siempre `--disk`.
- Desde un clon del repositorio en el servidor: `sudo bash install.sh --from-source --yes …` (compila; mucho más lento en una Raspberry Pi).

**Tarda 10-20 minutos** (más con visores). Si tu herramienta corta los comandos antes (muchas lo hacen a los 2-10 min), no lo lances en primer plano: ejecútalo como unidad de systemd y consulta su progreso, así sobrevive aunque se corte el SSH:

```bash
S: sudo systemd-run --unit=pcloud-install --collect \
     bash -c 'curl -fsSL https://raw.githubusercontent.com/crazyramirez/personal-cloud-storage/main/install.sh | bash -s -- --yes --disk <UUID> --viewers --no-tailscale'
S: systemctl is-active pcloud-install                                   # activating/active = sigue; inactive/failed = terminó
S: sudo grep '^=== \[' /var/log/pcloud-install.log | tail -n 1           # paso actual, p. ej. «=== [5/10] Instalando la aplicación»
S: sudo journalctl -u pcloud-install --no-pager -n 40                    # salida completa al terminar (incluye el código)
```

Consulta cada 1-2 minutos, no en bucle continuo. Si termina con error, la salida muestra «✗ …» y las últimas líneas del registro (`/var/log/pcloud-install.log`, solo root).

### 2.5 Verificación

```bash
S: curl -fsSL https://raw.githubusercontent.com/crazyramirez/personal-cloud-storage/main/install.sh | bash -s -- --check
```

Debe dar `pcloud.installed=yes`, `pcloud.service=active`, `caddy.service=active`, `pcloud.health=ok`, `pcloud.mounted=yes` y `pcloud.volume_state=READY` (sin disco vinculado, `UNAVAILABLE` o `NEEDS_CHECK` es lo normal). En el servidor también: `pcloud-volume-status` (exit 0 = disco listo; pide `sudo`).

### 2.6 Entrega a la persona

Dile, en este orden:

1. **Dirección:** `https://<host>.local` (o `https://<ip>`), con `host.name` y `host.ip` del diagnóstico. Las llaves de acceso (passkeys) solo funcionan con el nombre, no con la IP.
2. **Código para crear su cuenta** (un solo uso, 24 h): sale al final de la instalación («Código para crear tu cuenta»). Si se perdió y `pcloud.needs_owner=yes`, genera otro:
   ```bash
   S: sudo runuser -u pcloud -- node /opt/pcloud/current/apps/server/src/cli/admin.ts setup-token
   ```
3. **Aviso del certificado:** la primera vez el navegador avisa porque la CA es propia. Para quitarlo, instalar `https://<host>.local/pcloud-ca.crt` en cada dispositivo y comprobar que su huella SHA-256 coincide con la que mostró el instalador ([cómo, por sistema](docs/OPERATIONS.md#4-bis-acceso-a-la-web-y-primera-configuración)).
4. **No es una copia de seguridad:** si el disco falla, se pierden los datos.

La cuenta la crea la persona en la web; tú no.

### 2.7 Tailscale (solo si lo quiere)

1. Instalar con `--tailscale` (o después: `sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-install-tailscale.sh --execute`). La salida trae un enlace `https://login.tailscale.com/…`: dáselo; lo abre ella e inicia sesión.
2. Que active **MagicDNS** y **HTTPS Certificates** en la consola de Tailscale (DNS).
3. Entonces: `sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-install-caddy.sh --execute`.
4. Comprobar: `tailscale status` y `curl -sS -o /dev/null -w '%{http_code}\n' https://<host>.<tailnet>.ts.net/` → `200`. Fuera de casa entra con la app de Tailscale abierta y la misma cuenta.

### 2.8 Problemas frecuentes

| Síntoma | Qué hacer |
|---|---|
| `Arquitectura armhf/i386 no soportada` | Sistema de 32 bits: hay que grabar Raspberry Pi OS **64-bit** (borra la tarjeta: lo decide la persona) |
| `No hay ningún disco exFAT/NTFS conectado con UUID …` | Disco desconectado o UUID mal copiado: repetir `--check` |
| Falla `instalar la release` (pruebas en el equipo) | Ver `/var/log/pcloud-install.log`; la release anterior sigue activa. Suele ser falta de espacio o de RAM |
| `pcloud.volume_state` distinto de `READY` con el disco conectado | [OPERATIONS §6](docs/OPERATIONS.md#6-runbook-tras-una-desconexión-o-un-corte-de-corriente): comprobación de solo lectura con `fsck -n`; reparar solo con permiso explícito |
| «El disco no responde» / `IO_STALLED` | Casi siempre alimentación: [OPERATIONS §6 bis](docs/OPERATIONS.md#6-bis-runbook-el-disco-no-responde-io_stalled--io_timeout) |
| No abre `https://<host>.local` desde el móvil | Probar con la IP; mismo Wi-Fi; algunos Android no resuelven `.local` |
| Cambiar de disco | [OPERATIONS §7](docs/OPERATIONS.md#7-runbook-cambiar-de-disco) (desvincular es explícito y a mano) |

**Actualizar o reparar:** repetir §2.2-2.5 con el mismo comando. Es idempotente, reutiliza el disco vinculado y vuelve sola a la versión anterior si la nueva falla.

## 3. Trabajar en el código

- Monorepo pnpm: `apps/server` (Fastify + `StorageGuardian`), `apps/web` (Nuxt 4, SPA estática), `packages/contracts` (TypeBox), `deploy/` (scripts de Linux), `docs/` (spec, ADRs, operación).
- Node 26 ejecuta TypeScript directamente (type stripping): no hay build del servidor. pnpm sin instalación global: `npx pnpm@12.18.0`.
- Antes de dar algo por terminado: `npx pnpm@12.18.0 check` (tipos de servidor y web, i18n, tests y lint de scripts). Es lo mismo que la CI.
- Probar la web sin servidor real: `(cd apps/web && npx pnpm@12.18.0 run generate)` y `node apps/server/test/support/dev-server.ts 3999`.
- El código, los comentarios, la documentación y los mensajes de commit van en **español**. Los textos de la interfaz, por `apps/web/app/i18n/`.
- Los scripts de `deploy/` son dry-run sin `--execute`, idempotentes y con LF. `deploy/linux/check-scripts.sh` rechaza comandos destructivos de disco: no lo esquives.
- Mandato principal: la ausencia, desconexión o fallo del disco **nunca** puede tratarse como un borrado ni escribir en el disco del sistema. Lee [docs/STORAGE_CONTRACT.md](docs/STORAGE_CONTRACT.md) antes de tocar `apps/server/src/storage/`.
- Las decisiones de arquitectura están en [docs/adr/](docs/adr/README.md). Un ADR aceptado no se edita: se sustituye por otro.
