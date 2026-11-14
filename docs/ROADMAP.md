# Roadmap técnico

Sprints pequeños; cada uno entrega algo ejecutable con tests y documentación. Las cifras de rendimiento son **hipótesis iniciales** para la Pi 4B y se fijan definitivamente tras S0.3. "T#" remite a las pruebas de aceptación de la spec §15.

## Fase 0 — Auditoría e infraestructura

### S0.1 — Fundamentos ✅ (este incremento)
- Monorepo, auditoría, ADRs 0001-0008, scripts de diagnóstico de solo lectura, `StorageGuardian` y configuración.
- **Aceptación**
  - [x] `pnpm typecheck` sin errores; `pnpm test` en verde (102 tests; 108 en la Pi con los de integración).
  - [x] Matriz de 37 fallos inyectados: ninguno produce READY ni concede un lease de escritura.
  - [x] `pnpm check:scripts`: sintaxis bash, LF y ningún comando destructivo prohibido.
  - [x] Cero dependencias de runtime con binarios nativos.

### S0.2 — Descubrimiento e instalación sobre hardware real ✅
- ✅ Node 26.13.1 LTS + pnpm 12.18.0; sistema actualizado; smartmontools/hdparm/iperf3/fio.
- ✅ Usuario `pcloud`, `/etc/pcloud`, `/var/lib/pcloud`, mountpoint protegido, Wi-Fi sin ahorro de energía, SSH solo con clave.
- ✅ Despliegue por releases con tests en la Pi y rollback ([OPERATIONS.md](OPERATIONS.md)).
- ✅ HDD WD 5 TB formateado en exFAT (32 KiB, autorizado), en fstab, con la caché vaciándose de verdad y vinculado → **READY**.
- **Aceptación**
  - [x] userland `arm64` confirmado; H1-H30 rellenados.
  - [x] `pcloud-mountpoint-guard.sh check` devuelve 0 con el disco montado.
  - [x] Arranque sin HDD (antes de fstab) y con HDD (montaje automático, READY) en 26-27 s.
  - [x] F0-loop (kernel real, exFAT real, 14 escenarios) superado.
  - [x] F0 con desconexión física: ronda 1 encontró 2 fallos de durabilidad; ronda 2, con las correcciones, 43/43 íntegros ([ADR-0009](adr/0009-durabilidad-cache-y-directorios.md)).
  - [ ] Pendiente menor: medir el arranque con la entrada de fstab y el disco desconectado (`nofail` + `device-timeout=15s`).

### S0.3 — Estabilidad y medición
- Estrés de 1 h de lectura y escritura en una carpeta de ensayo del volumen de laboratorio; `iperf3`; throughput de lectura y escritura secuencial local; coste de SHA-256 y TLS en la CPU.
- **Aceptación**
  - [ ] `get_throttled = 0x0` tras 1 h de carga; temperatura < 75 °C.
  - [ ] Cero resets USB o errores de E/S en el registro del kernel (o quirk UAS documentado y validado).
  - [ ] Tabla de cifras medidas en `docs/OPERATIONS.md`: disco local, red, SHA-256 en MB/s, HTTPS con Caddy.

## Versión mínima usable ✅ (2026-11-14)

Corte vertical adelantado a petición del propietario: login, navegación, carpetas, subida reanudable y descarga, web con el diseño aprobado (claro y oscuro) y HTTPS en la LAN. Cubre parte de S1.1, S1.2, S1.3, S1.5, S1B.1, S1B.3 y S1B.4 ([ADR-0010](adr/0010-protocolo-subida-reanudable.md), [0011](adr/0011-https-lan-caddy.md), [0012](adr/0012-contratos-typebox.md)). Validación en [OPERATIONS.md §8](OPERATIONS.md). Hechos después (2026-11-14): menú contextual en todas las vistas, doble clic, selección múltiple con atajos, arrastrar para mover o copiar, filtro rápido, subidas de carpetas con progreso dentro de la carpeta, renombrar, mover, copiar, duplicar, papelera (restaurar, borrado definitivo solo del propietario, caducidad), ZIP en streaming, visores (imagen, vídeo/audio con conversión en la Pi, PDF, Office→PDF y texto), Actividad, Ajustes, llaves de acceso (Face ID / Windows Hello), PWA instalable y detección de disco bloqueado ([ADR-0013](adr/0013-disco-que-no-responde.md)). Falta: indexador y búsqueda global, diario de operaciones con `expectedRevision`, medición de RSS con 10 GiB, reanudar subidas tras cerrar la pestaña, virtualización de listas muy largas y acceso desde Internet (ADR-0016).

## Fase 1A — Núcleo de almacenamiento (API)

| Sprint | Contenido | Aceptación medible |
|---|---|---|
| **S1.1** Esqueleto de servidor | Fastify, modelo de error, `requestId`, logs estructurados, `/system/health` (reloj, alimentación, temperatura), `/system/storage` (guardián), unidad systemd endurecida, ADR-0011/0012/0013 | Con el HDD desenchufado, toda ruta de ficheros responde `503 STORAGE_UNAVAILABLE` en < 100 ms; el servicio arranca sin disco; el montaje en caliente se propaga al namespace (READY en ≤ 2 sondeos); RSS en reposo < 120 MB |
| **S1.2** Persistencia y auth | `node:sqlite` + migraciones + snapshot previo, Argon2id, sesiones, CSRF, rate limiting del login, token de setup inicial, `idempotency_keys`, `files.revision` | Tests de migración reversible; 10 intentos fallidos → 429; cookie `HttpOnly; Secure; SameSite=Strict`; ninguna contraseña ni token en logs (test) |
| **S1.3** Rutas, nombres y onboarding | Resolución de rutas por componentes, política de nombres portables (NFC, casefold, reservados), onboarding (marcador + `data/`) con lease de onboarding | Suite de traversal (T12) en verde; suite de nombres (T11); el onboarding es idempotente y nunca crea nada fuera del lease |
| **S1.4** Operaciones de ficheros | Listado paginado bajo demanda, crear carpeta, renombrar/mover con `expectedRevision`, papelera, restauración, diario de operaciones y recuperación tras crash | T7, T15; crash inyectado en cada transición del diario sin pérdida de la última versión íntegra |
| **S1.5** Transferencias | Subida reanudable (ADR-0010), staging en el HDD, cuotas y espacio mínimo, `507`, TTL de staging; descarga con Range, ETag y `Content-Disposition` | T2, T3, T9 (> 4 GB), T17; RSS < 200 MB durante una subida de 10 GiB; SHA-256 idéntico tras 3 cortes de red |
| **S1.6** Indexador y reconciliador | Escaneo por lotes, búsqueda básica, cambios externos, reconstrucción del índice | T10 (20 000 ficheros: página de 200 con p95 < 300 ms en la Pi), T16, T18 |
| **S1.7** Campaña de fallos y operación | Fault injection sobre el volumen de laboratorio, `OPERATIONS.md`, `BACKUP_RESTORE.md`, snapshots de la DB al HDD y a soporte externo | T1-T8, T19, T20 documentados con resultados |

## Fase 1B — Web Nuxt (SPA estática)

| Sprint | Contenido | Aceptación |
|---|---|---|
| S1B.1 | Sistema visual (claro/oscuro), layout, pantalla de disco ausente diferenciada. **Propuesta v1 (13 nov 2026):** [lienzo de diseño](https://claude.ai/artifact/TgMt2xw5YLfbA2Zev3hDX9) con Explorador, Panel, Transferencias, Disco no disponible y Configuración inicial | Aprobación del propietario; Lighthouse accesibilidad ≥ 90 |
| S1B.2 | Explorador: lista y cuadrícula, breadcrumbs, orden, búsqueda, selección múltiple, arrastrar y soltar | Carpeta de 20 000 entradas sin bloquear la UI (virtualización) |
| S1B.3 | Cola de transferencias: pausa, reanudación, reintento, velocidad | Subida de 10 GiB reanudada tras cerrar la pestaña |
| S1B.4 | Papelera, actividad, ajustes, setup, despliegue con Caddy | Instalación limpia documentada de extremo a extremo |

## Fases 2 y 3

- **2A** Electron Remote Explorer (vinculación de dispositivo, safeStorage, colas persistentes).
- **2B** Sincronización segura (cursor, tombstones, protección contra borrados masivos; T13, T14).
- **3** WireGuard, comparticiones de solo lectura, multiusuario, backups automatizados, miniaturas, migración de hardware.
