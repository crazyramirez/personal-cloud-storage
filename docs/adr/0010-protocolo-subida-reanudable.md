# ADR-0010 — Protocolo de subida reanudable por offset confirmado

**Estado:** Aceptado · 2026-11-14

## Contexto

Las subidas llegan por Wi-Fi a un disco SMR alimentado por USB que puede desaparecer en cualquier momento. Un `fsync` real cuesta ~60 ms ([ADR-0009](0009-durabilidad-cache-y-directorios.md)), así que no se puede sincronizar cada bloque. Aun así, el cliente nunca debe creer que hay en disco algo que no está, y un fichero a medias nunca debe aparecer en la nube ni sustituir a otro.

## Decisión

API bajo `/api/v1/uploads` (contratos en `packages/contracts/src/api.ts`):

| Paso | Petición | Efecto |
|---|---|---|
| Crear | `POST /uploads {path, name, size, sha256?}` | Valida el nombre (política portable) y el espacio (reserva → `507`). Crea `.pcloud/staging/<id>.part` en el **HDD** y una fila `uploads` en SQLite (`receiving`, `confirmed_offset = 0`). Devuelve `{id, offset, chunkSize, maxChunkSize}`. |
| Enviar | `PATCH /uploads/:id` con `Content-Type: application/offset+octet-stream` y `Upload-Offset: n` | Solo se acepta si `n` es igual al offset del servidor; si no, `409 OFFSET_MISMATCH` con `details.offset`. El cuerpo se escribe en streaming, sin acumularlo en memoria. Responde `204` con el nuevo `Upload-Offset`. |
| Consultar | `GET /uploads/:id` | Offset confirmado desde el que continuar. |
| Completar | `POST /uploads/:id/complete` | Protocolo de commit del ADR-0009: `fsync` del `.part`, comprobación de SHA-256 si se declaró, `revalidate(lease)`, `rename` a un nombre libre, `fsync` del directorio, `completed` en SQLite. Idempotente. |
| Cancelar | `DELETE /uploads/:id` | Borra el `.part`. |

Reglas:

- **Offset confirmado = offset sincronizado.** Hay un `fsync` y se persiste `confirmed_offset` cada 64 MiB (punto de control) y al completar. Si cambia la generación del volumen o se reinicia el proceso, el `.part` se trunca al último offset confirmado. El cliente vuelve a enviar desde ahí: puede repetir hasta 64 MiB, pero nunca da por guardado algo que no lo está.
- **Nunca se sobrescribe.** Si el nombre existe al completar, se guarda como `nombre (2).ext`, `(3)`… y la respuesta indica el nombre final.
- **Commits serializados** por proceso: dos subidas con el mismo nombre no pueden elegir el mismo destino libre.
- Si el `rename` falla (disco desconectado), la subida vuelve a `receiving` con su `.part` intacto y se puede completar después.
- Un bloque como máximo por subida (`409 CONFLICT` reintentable si llega otro en paralelo). `maxChunkSize` limita cada `PATCH` (16 MiB por defecto). Caddy limita el cuerpo a 64 MiB.
- Caducidad: las subidas sin actividad durante `staging_ttl_hours` se cancelan, **solo** con el volumen READY. Al recuperar el disco nunca se purga nada: primero se reconcilia (`recover()`).
- Todas las rutas exigen `assertWritableVolume()`; sin disco, `503 STORAGE_UNAVAILABLE` y el cliente espera y reintenta solo.

Cliente web: cola con 2 subidas en paralelo y bloques secuenciales. Ante `STORAGE_UNAVAILABLE`, error de red o 5xx pasa a «en espera» y reintenta con espera exponencial (2 s → 30 s), preguntando antes el offset. Ante `OFFSET_MISMATCH` continúa desde `details.offset`.

## Consecuencias

- La subida sobrevive a cortes de red, desconexión del disco y reinicios del servidor, sin escribir nada en la microSD.
- Repetir hasta 64 MiB tras un corte es el precio de no hacer `fsync` por bloque.
- Cerrar la pestaña pierde la referencia al `File`. Reanudar tras cerrar la pestaña (S1B.3) exigirá guardar el `id` y volver a elegir el fichero.
- Observado en la Pi (2026-11-14): de forma intermitente (1 de 21 intentos), un rechazo `409` enviado antes de leer un cuerpo grande llegó al cliente como conexión reiniciada a través de Caddy. El cliente lo trata como error de red, pregunta el offset y continúa: no hay pérdida, solo un reintento.

## Alternativas descartadas

- **tus 1.0 completo:** el núcleo es equivalente, pero la extensión de creación y sus cabeceras añaden superficie sin beneficio para un único cliente propio. Se conservan sus nombres (`Upload-Offset`, `application/offset+octet-stream`) por si se adopta más adelante.
- **multipart en una sola petición:** no se puede reanudar y obliga a reenviar ficheros grandes enteros.
- **`fsync` por bloque:** con 8 MiB por bloque añadiría ~60 ms por bloque sin una mejora real de la garantía, porque el cliente ya reenvía desde el punto de control.
