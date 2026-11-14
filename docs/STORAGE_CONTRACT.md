# Contrato de almacenamiento

Define cuándo el servidor puede tocar el HDD. Implementación: [`storage-guardian.ts`](../apps/server/src/storage/storage-guardian.ts). Decisiones: [ADR-0003](adr/0003-modelo-estados-volumen.md), [ADR-0004](adr/0004-identidad-volumen-y-leases.md).

## 1. Estados del volumen

| Estado | Significado | Lecturas | Mutaciones | Reintentable | UI |
|---|---|---|---|---|---|
| `INITIALIZING` | Primera comprobación en curso | ✗ | ✗ | sí | "Comprobando disco…" |
| `READY` | Montado, identificado, escribible | ✓ | ✓ | — | Normal |
| `READ_ONLY` | Volumen correcto en solo lectura | ✓ | ✗ | no | Aviso + explorador sin acciones |
| `UNAVAILABLE` | No montado, desconectado o indeterminable | ✗ | ✗ | sí | **Pantalla de disco ausente** (no "carpeta vacía") |
| `WRONG_VOLUME` | Hay otro disco montado | ✗ | ✗ | no | "Este no es tu disco" |
| `NEEDS_CHECK` | Volumen esperado que requiere intervención | ✗ | ✗ | no | Instrucciones según el código |
| `UNHEALTHY` | Errores de E/S | ✗ | ✗ | sí | Alerta: revisar cable, alimentación y registro del kernel |

Solo `READY` admite mutaciones. Toda mutación rechazada devuelve `503 STORAGE_UNAVAILABLE` con `details.volumeState` y `details.issues`.

## 2. Secuencia de comprobación

La primera condición que falla determina el estado. READY exige demostrar **todas** las condiciones; cualquier excepción no prevista se clasifica como `UNAVAILABLE`/`UNHEALTHY`/`NEEDS_CHECK`, nunca como READY.

1. UUID configurado → `NEEDS_CHECK NOT_CONFIGURED`
2. `/proc/self/mountinfo` legible y bien formado → `UNAVAILABLE MOUNTINFO_UNREADABLE`
3. El mountpoint existe y es canónico → `UNAVAILABLE NOT_MOUNTED` / `NEEDS_CHECK MOUNTPOINT_INVALID`
4. Hay un único montaje visible (se resuelven las pilas) → `NOT_MOUNTED` / `MOUNT_AMBIGUOUS`
5. No es el FS de la microSD (bind de systemd) → `UNAVAILABLE NOT_MOUNTED`
6. `stat(mountpoint).dev` coincide con mountinfo → `UNAVAILABLE MOUNT_CHANGED`
7. Existe `/dev/disk/by-uuid/<UUID>` → `UNAVAILABLE DEVICE_ABSENT`, o `WRONG_VOLUME SOURCE_MISMATCH` si hay otro disco montado
8. El dispositivo montado es ese UUID (major:minor; FUSE: ruta real) → `WRONG_VOLUME SOURCE_MISMATCH`
9. FS completo (`root=/`), tipo configurado, sin `force` → `NEEDS_CHECK`
10. `.pcloud/` es un directorio real del volumen; `volume-id` es v1 y coincide → `NEEDS_CHECK NOT_ONBOARDED|MARKER_*` / `WRONG_VOLUME MARKER_MISMATCH`
11. La raíz de datos es un directorio real del volumen → `NEEDS_CHECK DATA_ROOT_INVALID`
12. Montaje `rw` y `access(W_OK)` concedido → `READ_ONLY` / `NEEDS_CHECK PERMISSION_DENIED`

El guardián **nunca escribe**: solo usa `readFile(/proc)`, `lstat`, `stat`, `realpath`, `open(O_RDONLY|O_NOFOLLOW)` y `access`.

## 3. Leases y generaciones

```ts
const lease = await guardian.assertWritableVolume();   // falla si no está READY
// ... escribir en .pcloud/staging/<id>.part, verificar longitud/hash ...
await guardian.revalidate(lease);                       // justo antes de confirmar
// ... rename final + commit SQLite ...
```

- La generación aumenta con **cada** cambio de estado o de identidad de montaje (`mountId|major:minor|marcador`).
- `revalidate` falla si la generación cambió, aunque el disco vuelva a estar READY: una desconexión observada invalida todas las operaciones en vuelo.
- Límite conocido: Linux reutiliza los ids de montaje. Un desenchufado y reenchufado completo entre dos sondeos, en el mismo puerto, podría no verse. Por eso toda confirmación verifica además el fichero staged (longitud y, si existe, SHA-256) **después** de revalidar.
- Las comprobaciones concurrentes comparten la *siguiente* evaluación, nunca una ya empezada: el resultado siempre es posterior a la llamada.

## 4. Invariantes

1. Nada fuera del onboarding crea `.pcloud/` ni la raíz de datos. El onboarding exige `NEEDS_CHECK` con `NOT_ONBOARDED` como única causa y un montaje `rw`.
2. Nunca se escribe en el mountpoint sin un lease vigente. Si el disco falta, el directorio de la microSD es `root:root 0555 +i` ([ADR-0005](adr/0005-montaje-y-mountpoint-protegido.md)).
3. Ningún estado distinto de READY dispara purgas, limpieza de staging, papelera, versiones ni reindexaciones destructivas.
4. Al pasar de no-READY a READY se reconcilia primero el diario de operaciones; después se reanudan las tareas.
5. La ausencia de ficheros durante un estado no-READY jamás se interpreta como borrado.

## 5. Raíz administrada y exclusiones

- `.pcloud/` está siempre en la raíz del FS y nunca se indexa ni se sincroniza.
- Con `root_relative: "."` también se excluyen: `System Volume Information`, `$RECYCLE.BIN`, `.Trashes`, `.Spotlight-V100`, `.fseventsd`, `.TemporaryItems`.

## 6. Sustitución segura de un fichero (protocolo para S1.4/S1.5, [ADR-0009](adr/0009-durabilidad-cache-y-directorios.md))

Requisito previo: la caché del disco se vacía de verdad en cada `fsync` (`/sys/block/sdX/queue/write_cache` = `write back`).

1. Diario: `PREPARING` (destino, revisión esperada, ruta staged).
2. Escribir el staged en `.pcloud/staging/<op>.part`. Hacer `fsync` en puntos de control (cada 64-128 MiB, que fijan el offset reanudable) y al final, nunca por chunk: cada vaciado cuesta ~60 ms. Verificar longitud y hash → `STAGED`.
3. `revalidate(lease)`; comprobar la revisión esperada (`409` si no coincide).
4. `COMMITTING`: renombrar el fichero actual a `.pcloud/versions/<op>` (o a la papelera), `fsync` de ese directorio; después renombrar el staged al destino y hacer **`fsync` del directorio destino**.
5. `COMMITTED` en SQLite + entrada en `change_log`, solo después del paso 4.
6. Recuperación tras un crash: en cada estado existe al menos una copia íntegra identificada por el diario (la anterior o la staged). Un `COMMITTING` cuyo destino no existe pero cuyo `.part` está completo y con el hash esperado se resuelve **rehaciendo el rename**, nunca como pérdida. Nunca se borra automáticamente el único ejemplar.

Comportamiento medido con desconexión física (F0, 2026-11-13): lo confirmado con este protocolo sobrevivió siempre (43/43); lo no confirmado puede desaparecer por completo (sin `.part` residual) o quedar como `.part`.
