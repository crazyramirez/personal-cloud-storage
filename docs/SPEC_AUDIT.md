# Auditoría técnica de la especificación v1.0

**Fecha:** 2026-11-13 · **Alcance:** [SPEC.md](SPEC.md) · **Plataforma:** Raspberry Pi 4B 8 GB Rev 1.5 con Raspberry Pi OS Lite 64-bit (trixie); sustituye a la Orange Pi Zero 2W, ver [ADR-0008](adr/0008-plataforma-raspberry-pi-4b.md)

La especificación es sólida en lo esencial: falla en cerrado, sin reformateo, índice reconstruible, sincronización ≠ backup. Esta auditoría recoge lo que hay que resolver **antes** de escribir lógica destructiva: contradicciones, riesgos, supuestos, omisiones y decisiones que solo puede tomar el propietario.

Estado de cada punto: ✅ resuelto en código/ADR · 🟡 resolución propuesta, se implementa en el sprint indicado · ❓ decisión del propietario.

## 1. Contradicciones y ambigüedades

| # | Sección | Problema | Resolución | Estado |
|---|---|---|---|---|
| C1 | §3.4.6 vs lista de estados | `UNHEALTHY` se usa en §3.4.6 pero no está entre los estados expuestos. `SCANNING` mezcla el estado del indexador con el del volumen: un volumen puede estar READY y escaneándose. | 7 estados de volumen (incluye `UNHEALTHY`); el indexador tiene su propio estado. | ✅ [ADR-0003](adr/0003-modelo-estados-volumen.md) |
| C2 | §13 | `on_missing_volume` es configurable, pero §3.4.6 exige rechazar **siempre** las mutaciones sin volumen. Un valor alternativo solo podría ser inseguro. | Clave eliminada; el validador explica por qué. | ✅ [ADR-0007](adr/0007-configuracion-estricta.md) |
| C3 | §13 vs §1 | `require_auth: true` configurable contradice "seguridad por defecto". | Eliminada. Primer arranque: token de un solo uso en el journal para crear el propietario. | ✅ / 🟡 S1.2 |
| C4 | §3.2 vs onboarding (c) | `root_relative: data` fijo, pero el onboarding ofrece "administrar una raíz existente". | `root_relative` lo fija el onboarding; `.pcloud/` siempre en la raíz del FS; `"."` permitido con exclusiones explícitas. | ✅ [ADR-0006](adr/0006-layout-fisico-volumen.md) |
| C5 | §13 | `fs_type: exfat_or_ntfs3` no es un valor válido. | Valores `exfat \| ntfs3 \| ntfs-3g`; el placeholder se rechaza. | ✅ |
| C6 | §3.3 | Montar "NTFS" es ambiguo: `-t ntfs` puede invocar el helper `mount.ntfs` (ntfs-3g) o, en kernels recientes, el alias `ntfs` de ntfs3 en modo legado. | fstab con tipo explícito (`ntfs3` o `ntfs-3g`); el guardián compara el tipo **real** de mountinfo (`fuseblk` para ntfs-3g) y exige coincidencia. | ✅ |
| C7 | §3.3 | Si `exfat-fuse` está instalado, su helper `mount.exfat` puede convertir `-t exfat` en un montaje FUSE. | El inventario detecta helpers; el guardián exige fstype `exfat`. | ✅ |
| C8 | §6 `files.id` | "Id estable" no es alcanzable para cambios externos: exFAT en Linux sintetiza inodos no estables entre montajes. Un renombrado hecho en Windows aparece como baja + alta. | Id estable para operaciones vía API. El reconciliador trata las desapariciones con periodo de gracia, nunca como borrado inmediato. | 🟡 S1.6 |
| C9 | §6 `mtime_ns` | Sugiere precisión de ns. exFAT guarda 10 ms y un offset de zona horaria; NTFS 100 ns. | Comparar fingerprints con tolerancia según FS; documentar en STORAGE_CONTRACT. | 🟡 S1.6 |
| C10 | §6 vs §7.2/§8 | Se exige `If-Match`/`expectedRevision` e idempotencia, pero el modelo no tiene `files.revision` ni tabla de claves de idempotencia. | Añadir `files.revision` e `idempotency_keys(key, actor, request_hash, response, expires_at)`. | 🟡 S1.2 |
| C11 | §7.2 sustitución | En exFAT/NTFS desde Linux, renombrar sobre un destino existente no es atómico ante un corte de corriente. **Confirmado por F0:** sin `fsync` del directorio, un rename se pierde. | Protocolo con diario: anterior → `.pcloud/versions\|trash`, staged → final, **fsync del directorio**, commit. El staged no se borra hasta el commit. | ✅ protocolo en [ADR-0009](adr/0009-durabilidad-cache-y-directorios.md); 🟡 implementación en S1.4 |
| C12 | §12.1 vs §3.4.7 | Para "apagado limpio" es tentador usar `RequiresMountsFor=`, pero eso pararía la API sin disco, y §3.4.7 exige que siga respondiendo. | Solo `After=`; el servicio arranca sin disco y responde 503. | ✅ [ADR-0005](adr/0005-montaje-y-mountpoint-protegido.md) |
| C13 | §11 systemd | `ProtectSystem=strict` + `ReadWritePaths=/srv/pcloud` crean un namespace con un bind del mountpoint. Si el HDD se monta después, hay que confirmar que el montaje se propaga y que el guardián ve el superior. | El guardián ya resuelve montajes apilados (test). Falta validar la propagación en hardware real. | 🟡 S1.1 |
| C14 | §9 vs §14 | Explorador con miniaturas en 1B, pero las miniaturas son Fase 3. | 1B: sin miniaturas de servidor; vista de cuadrícula con iconos y carga diferida de imágenes pequeñas. Miniaturas en Fase 3 (evaluar libvips nativo). | 🟡 |
| C15 | §8 subidas | "Offset confirmado y/o chunks numerados": hay que elegir una sola variante. | Propuesta: offset confirmado por servidor (estilo tus), PATCH secuencial, SHA-256 final opcional por chunk. | 🟡 ADR-0010, S1.5 |
| C16 | §2, §13.1 | Hardware Orange Pi Zero 2W, límites USB 2.0 / 100 Mb/s. | Sustituido por Pi 4B: USB 3.0 y Gigabit. Nuevos cuellos de botella: CPU sin extensiones criptográficas y 1,2 A compartidos en USB. | ✅ [ADR-0008](adr/0008-plataforma-raspberry-pi-4b.md) |
| C17 | §11 | Cookie `Secure` = HTTPS también en LAN, pero no se define la estrategia de certificados. | Decisión D4. | ❓ |
| C18 | §4, §10 | Electron lleva su propio Node: `node:sqlite` y otras APIs pueden diferir del servidor. | `sync-core` con almacenamiento abstraído; decidirlo en Fase 2. | 🟡 Fase 2 |

## 2. Riesgos

Probabilidad/Impacto: A alta, M media, B baja.

| ID | Riesgo | P | I | Mitigación | Verificación |
|---|---|---|---|---|---|
| R1 | **Alimentación**: los puertos USB de la Pi 4 comparten 1,2 A. Un HDD de 2,5" en el arranque del motor puede provocar subtensión → desconexión a mitad de escritura → corrupción de exFAT. **Confirmado: el 2,5" se alimenta por el USB de la Pi.** | A | A | Caja o hub con alimentación propia (obligatoria para 3,5"), fuente oficial de 5,1 V/3 A, `vcgencmd get_throttled` en el inventario y en `/system/health`. | S0.3: 1 h de estrés con `throttled=0x0` |
| R2 | Puentes USB-SATA con **UAS** inestable en la Pi 4 (resets, EIO). | M | A | Identificar VID:PID; aplicar `usb-storage.quirks=VID:PID:u` **solo** si hay resets en el registro del kernel. El guardián pasa a UNHEALTHY. | S0.3 |
| R3 | exFAT sin journal: un corte puede dejar FAT y bitmap incoherentes. | M | A | Guardián, staging + diario, detección de VolumeDirty, `fsck.exfat -n` con el volumen desmontado, backup. | S1.7 |
| R4 | Madurez de ntfs3 frente al rendimiento FUSE de ntfs-3g. | M | A | Probar ambos en un volumen de laboratorio y elegir por resultados. | S0.2/S0.3 |
| R5 | Desgaste de la **microSD** (SQLite WAL, journald, swapfile de Raspberry Pi OS). | A | M | Tarjeta high-endurance; límites de journald; zram en lugar de swapfile en la SD; snapshots de la DB al HDD y a soporte externo. | S0.2, S1.2 |
| R6 | **Sin RTC**: si arranca sin red, la hora es incorrecta y afecta a mtime, sesiones, TLS y cursores. | M | M | Exponer `clock.synchronized`; política D6. | S1.1 |
| R7 | **CPU sin AES/SHA por hardware** (BCM2711): HTTPS y SHA-256 pueden quedar por debajo del Gigabit. | A | M | ChaCha20-Poly1305 (Go/Caddy lo prefieren sin AES en hardware), hash perezoso, medir. | S0.3 |
| R8 | Automontaje de udisks2 (imágenes con escritorio) en `/media/<usuario>`. | M | M | Imagen Lite/Server; regla udev `UDISKS_IGNORE` para el UUID. | Inventario |
| R9 | El escaneo inicial de 4 TB (millones de ficheros) tarda horas. | A | B | Navegación bajo demanda, escaneo por lotes con baja prioridad. | S1.6 |
| R10 | Carreras en la resolución de rutas: Node no expone `openat`/`O_BENEATH`. | B | A | Sin symlinks, `lstat` por componente, `O_NOFOLLOW`. Riesgo residual aceptado (un solo propietario). | S1.3 |
| R11 | Unicode NFC/NFD y mayúsculas: ntfs3 distingue mayúsculas en Linux y Windows no. | M | M | Política de nombres en la aplicación; colisiones por casefold + NFC. | S1.3 |
| R12 | Spin-down del HDD y autosuspend USB: latencias de 5-10 s o desconexiones. | M | M | Medir; ajustar hd-idle/hdparm; timeouts del cliente. | S0.3 |
| R13 | `node:sqlite` y `crypto.argon2` son APIs recientes. | B | M | Node 26 LTS fijado, tests en arm64; alternativas documentadas (better-sqlite3, scrypt). | S1.2 |
| R14 | Throttling térmico bajo carga sostenida (80 °C). | M | B | Disipador/ventilador, monitorización. | S0.3 |
| R15 | Contenido activo subido (HTML/SVG). | M | A | `Content-Disposition: attachment`, CSP sandbox, vista previa solo de tipos seguros. | S1.5 |
| R16 | Un solo HDD = punto único de fallo, y **no existe ninguna copia** (D5). | A | A | Conseguir un segundo disco antes de confiar datos únicos al sistema. Mientras tanto: primer montaje del disco real **en solo lectura** y pruebas destructivas solo en un volumen de laboratorio. | S0.2 |
| R17 | SSH con contraseña corta, `PasswordAuthentication yes` y la contraseña ha pasado por este chat. | M | A | ✅ SSH solo con clave, sin root (`pcloud-ssh-hardening.sh`). Pendiente: cambiar la contraseña (consola y `sudo`). Cortafuegos en S1.1. | S0.2 |
| R18 | **Caché de escritura del disco sin vaciar:** el puente USB oculta la página de caché, el kernel asume *write through* y `fsync` no persiste ante un corte. | A | A | ✅ Regla udev `temporary write back` y protocolo de commit con fsync de directorio ([ADR-0009](adr/0009-durabilidad-cache-y-directorios.md)). Validado en F0 ronda 2. | S0.2 |
| R19 | Disco **SMR** (WD50NDZW): las escrituras sostenidas largas se ralentizan al llenarse su caché CMR interna; cada `fsync` real cuesta ~60 ms. | A | M | Sin fsync por chunk; medir subidas de 10+ GiB (S0.3); evaluar TRIM, que el puente admite. | S0.3 |
| R20 | Tras una desconexión, systemd desmonta solo pero **no remonta al reconectar**. | A | M | Runbook en OPERATIONS §6; decidir la política de remontaje (¿solo tras `fsck -n` limpio?) en ADR-0014. | S1.7 |

## 3. Supuestos adoptados (pendientes de confirmar con el inventario)

1. **Userland de 64 bits (`arm64`)**. Es obligatorio: Node 26 no publica binarios `armv7l` (comprobado en el índice oficial). Ojo: Raspberry Pi OS de 32 bits puede arrancar un kernel aarch64 con userland armhf, así que `uname -m` no basta; hay que mirar `dpkg --print-architecture`.
2. Raspberry Pi OS Lite 64-bit o Ubuntu Server arm64, con systemd.
3. Kernel con módulo `exfat` (≥ 5.7). La disponibilidad de `ntfs3` se verifica.
4. HDD con una única partición de datos (GPT o MBR).
5. Un propietario, un volumen activo, uso en LAN.
6. Sistema en la microSD (como en la spec); arrancar desde USB queda fuera de alcance por ahora.

## 4. Omisiones de la spec

- O1. Tabla de claves de idempotencia y `files.revision` (C10).
- O2. Mecanismo de alta del primer propietario sin exponer un formulario abierto (token de un solo uso, C3).
- O3. Política de reloj (R6).
- O4. Límites de memoria del proceso (`MemoryMax=` en systemd) y de descriptores abiertos.
- O5. Salud de la alimentación en la API (`vcgencmd`, R1).
- O6. Límite del tamaño total de staging y su limpieza con disco lleno (`507`).
- O7. Procedimiento de "retirar el disco" en la UI (bloquear mutaciones, drenar transferencias, `umount`), pedido en Fase 0 pero sin diseñar.

## 5. Decisiones del propietario

| # | Pregunta | Respuesta / estado | Recomendación |
|---|---|---|---|
| D1 | ¿exFAT o NTFS? | ✅ **exFAT**, se mantiene el formato del disco | Controlador `exfat` del kernel |
| D2 | ¿Tiene ya datos el disco? ¿Cuántos TB y ficheros aproximados? | ✅ Disco **nuevo y vacío** (WD 5 TB). Formateado en exFAT con autorización; onboarding (a) "empezar vacío" | — |
| D3 | ¿Ethernet o Wi-Fi? | Hoy por **Wi-Fi** (5 GHz, −46 dBm, ahorro de energía desactivado); Ethernet más adelante | Ethernet (Gigabit nativo) |
| D4 | HTTPS en LAN | ❓ pendiente (S1.1) | (a) CA local con Caddy `tls internal` (instalar la raíz en cada dispositivo) · (b) dominio propio + ACME DNS-01 · (c) HTTP solo durante S1. Recomendación: (a) |
| D5 | ¿Hay un segundo disco para backup? | ❌ **No** | Conseguirlo antes de confiar datos únicos (R16) |
| D6 | ¿Bloquear mutaciones hasta que NTP sincronice? | ❓ pendiente (S1.1) | Sí |
| D7 | ¿Qué SO lleva la Pi 4B? | ✅ Raspberry Pi OS Lite 64-bit, Debian 13 trixie, userland arm64 | — |
| D8 | HDD de 2,5" o 3,5", ¿y qué alimentación? | 2,5" **alimentado por el USB de la Pi**; sin subtensión medida, ni en escrituras sostenidas ni en los arranques del motor | Vigilar `get_throttled`; si hay subtensión, cable en Y o hub alimentado |
