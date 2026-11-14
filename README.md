<p align="center">
  <img src="docs/assets/header.jpg" alt="Personal Cloud Storage — tu nube en casa: un servidor pequeño, un disco USB y nada más" width="100%">
</p>

# Personal Cloud Storage

Nube personal autocontenida: un servidor Linux pequeño (una **Raspberry Pi**, un mini PC o un portátil viejo) con un **HDD USB en exFAT o NTFS**, sin servicios de terceros. Explorador web con subidas reanudables, papelera, visores, llaves de acceso (passkeys) y acceso remoto privado opcional por Tailscale.

> **Mandato principal:** la ausencia, desconexión o fallo del disco nunca puede interpretarse como un borrado ni producir escrituras en el disco del sistema.

## Funciones

- Explorador web (SPA, móvil y escritorio): navegar, crear carpetas, subir (reanudable, sin sobrescribir), descargar, mover, copiar, renombrar, ZIP, papelera y recientes.
- Visores de imagen, vídeo, audio, PDF y documentos de Office (con ffmpeg y LibreOffice, opcionales).
- Cuentas con contraseña (Argon2id) y llaves de acceso; sesiones revocables; registro de auditoría.
- HTTPS en la LAN con CA propia (Caddy). Acceso remoto solo por VPN (Tailscale), **nunca** abierto a Internet.
- `StorageGuardian`: bloquea las escrituras en cuanto el disco desaparece, se cuelga o cambia, y nunca escribe en el mountpoint vacío.
- Los ficheros siguen siendo ficheros normales en el disco: lo conectas a Windows o macOS y los lees tal cual.

## Requisitos

| | Soportado |
|---|---|
| **Sistema** | Linux de 64 bits con systemd. Los scripts de instalación usan `apt`: **Debian 12+, Ubuntu 24.04+ o Raspberry Pi OS 64-bit**. Otras distribuciones: instalando a mano las dependencias. |
| **Arquitectura** | **ARM64** (Raspberry Pi 4/5 y otras SBC) o **x86-64** (mini PC, NUC, portátil, VM con el disco pasado por USB). Sin builds de 32 bits (Node 26). |
| **Disco** | HDD o SSD USB **ya formateado** en exFAT (recomendado) o NTFS. Los scripts nunca formatean. |
| **No soportado como servidor** | Windows y macOS (el guardián lee `/proc/self/mountinfo` y `/sys`). Sirven para desarrollar con el servidor de pruebas. |
| **Docker** | No soportado todavía: dentro de un contenedor la detección de desmontajes ve otro espacio de montajes y está sin validar. |

Hardware de referencia (donde se han hecho las pruebas físicas de desconexión): Raspberry Pi 4B 8 GB, Raspberry Pi OS Lite 64-bit, HDD USB de 2,5" de 5 TB en exFAT. En la Raspberry Pi usa una **fuente oficial** (no una power bank) y, para discos de 2,5" exigentes o de 3,5", un hub o caja con alimentación propia.

## Instalación rápida

Guía completa y runbooks: [docs/OPERATIONS.md](docs/OPERATIONS.md).

1. En el servidor: copia `deploy/` y ejecuta los scripts de [OPERATIONS §3](docs/OPERATIONS.md#3-instalación-desde-cero-orden) (todos son dry-run sin `--execute` e idempotentes).
2. En tu ordenador: `bash deploy/dev/pack-release.sh` y copia el paquete al servidor.
3. En el servidor: `sudo bash deploy/linux/setup/pcloud-deploy-release.sh install /tmp/pcloud-*.tar.gz`.
4. Abre `https://<nombre-del-servidor>.local/` y crea la cuenta de propietario con el código de un solo uso del registro.

> ⚠️ Esto **no es una copia de seguridad**. Si el disco falla, se pierden los datos. Ten otra copia de lo que te importe.

## Documentación

| Pieza | Ubicación |
|---|---|
| Auditoría de la spec (contradicciones, riesgos, decisiones pendientes) | [docs/SPEC_AUDIT.md](docs/SPEC_AUDIT.md) |
| Datos de hardware que hay que verificar | [docs/HARDWARE_DISCOVERY.md](docs/HARDWARE_DISCOVERY.md) |
| Decisiones de arquitectura | [docs/adr/](docs/adr/README.md) |
| Contrato de almacenamiento (estados, leases, invariantes) | [docs/STORAGE_CONTRACT.md](docs/STORAGE_CONTRACT.md) |
| Roadmap por sprints | [docs/ROADMAP.md](docs/ROADMAP.md) |
| `StorageGuardian` + tests | [apps/server/src/storage/](apps/server/src/storage/), [apps/server/test/](apps/server/test/) |
| API (Fastify), auth, subidas | [apps/server/src/http/app.ts](apps/server/src/http/app.ts), [apps/server/src/storage/uploads.ts](apps/server/src/storage/uploads.ts) |
| Web (Nuxt, SPA estática) | [apps/web/](apps/web/) |
| Servicio systemd y Caddy | [deploy/linux/systemd/](deploy/linux/systemd/), [deploy/linux/caddy/](deploy/linux/caddy/) |
| Scripts de diagnóstico (solo lectura) | [deploy/linux/diagnostics/](deploy/linux/diagnostics/) |
| Protección del mountpoint (dry-run por defecto) | [deploy/linux/setup/pcloud-mountpoint-guard.sh](deploy/linux/setup/pcloud-mountpoint-guard.sh) |
| Instalación del servidor y despliegue por releases | [deploy/linux/setup/](deploy/linux/setup/), [deploy/dev/pack-release.sh](deploy/dev/pack-release.sh) |
| Operación del servidor | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| Laboratorio F0 con exFAT real en RAM | [tests/fault-injection/](tests/fault-injection/README.md) |

## Estructura

```text
apps/server/          API (Fastify) + StorageGuardian + configuración + CLIs de operación
apps/web/             Web (Nuxt 4, SPA estática con CSP por hashes)
packages/contracts/   Esquemas TypeBox y tipos de la API v1 compartidos con web/desktop
deploy/config/        config.example.yaml
deploy/linux/         diagnóstico, setup y check-scripts.sh
docs/                 auditoría, ADRs, contratos, roadmap
tests/fault-injection Protocolos de pruebas físicas
```

`apps/desktop`, `packages/sdk`, `packages/ui` y `packages/sync-core` se crean en su fase.

## Desarrollo

Requisitos: Node 26 LTS. pnpm 12 (sin instalación global: `npx pnpm@12.18.0`).

```bash
npx pnpm@12.18.0 install
npx pnpm@12.18.0 typecheck      # tsc 7, solo comprobación de tipos
npx pnpm@12.18.0 test           # node --test
npx pnpm@12.18.0 check:scripts  # bash -n, LF y comandos prohibidos
```

Probar la interfaz sin servidor (API real sobre un volumen temporal; `/__dev/disconnect` y `/__dev/reconnect` simulan el disco):

```bash
(cd apps/web && npx pnpm@12.18.0 run generate)
node apps/server/test/support/dev-server.ts 3999       # http://127.0.0.1:3999, imprime el código de configuración
```

El servidor se ejecuta directamente desde TypeScript (type stripping de Node, [ADR-0001](docs/adr/0001-monorepo-pnpm-typescript-nativo.md)); no hay paso de build.

## En el servidor

Instalación, despliegue por releases, rollback y comprobaciones: [docs/OPERATIONS.md](docs/OPERATIONS.md).

```bash
bash deploy/dev/pack-release.sh                                   # en desarrollo (compila también la web)
sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-deploy-release.sh install /tmp/pcloud-*.tar.gz
pcloud-volume-status [--uuid <UUID>] [--watch 1]                  # veredicto del guardián (solo lectura)
```

Ningún script de este repositorio formatea, particiona, repara ni borra datos del HDD.

## Licencia

[MIT](LICENSE). Especificación original: [docs/SPEC.md](docs/SPEC.md).
