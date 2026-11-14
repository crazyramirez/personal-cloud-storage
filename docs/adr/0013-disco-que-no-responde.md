# ADR-0013 — Detección de un disco que deja de responder

**Estado:** Aceptado · 2026-11-14 · Origen: incidente en la Pi (ver [OPERATIONS.md §8 bis](../OPERATIONS.md))

## Contexto

El 2026-11-14, con la CPU al máximo por LibreOffice y ffmpeg y escrituras sincronizadas en curso, el WD My Passport dejó de responder. El puente USB respondió primero *«Logical unit is in process of becoming ready»* y después *«internal target failure»*. Cada orden agotaba los 180 s de espera del kernel y se perdieron escrituras pendientes.

El StorageGuardian siguió publicando **READY**: todas sus comprobaciones (montaje, `stat`, marcador, permisos) se resolvían desde la caché del kernel sin tocar el disco. Mientras tanto, cada petición que sí llegaba al disco se quedaba colgada para siempre, igual que la interfaz que la esperaba. Es un fallo del principio «fallar en cerrado»: el guardián detectaba desconexiones y errores, pero no un disco que no contesta.

## Decisión

Dos detectores independientes en el StorageGuardian:

1. **Bloqueo según el kernel (`IO_STALLED`).** En cada comprobación se leen los contadores de `/sys/dev/block/M:m/stat` del dispositivo montado. Los publica el kernel y su lectura nunca se cuelga. Si hay peticiones en curso y el número de peticiones completadas no avanza durante `stallMs` (20 s), el estado pasa a **UNHEALTHY**: lecturas y escrituras se rechazan con `503` al instante.
2. **Límite de tiempo de la propia comprobación (`IO_TIMEOUT`).** Si una evaluación tarda más de `probeTimeoutMs` (8 s), se publica UNHEALTHY sin esperarla. Mientras siga pendiente no se lanza otra (el pool de hilos de libuv no se agota). Su resultado tardío se descarta.

Al recuperarse, el estado cambia y aumenta la **generación**: las operaciones empezadas antes no pueden confirmarse (`revalidate`).

Medidas complementarias:
- `UV_THREADPOOL_SIZE=16` en `pcloud.service`: unas pocas operaciones de disco atascadas no dejan sin hilos al inicio de sesión ni al resto.
- La interfaz no espera indefinidamente: 45 s por petición (2 min por bloque de subida). Las subidas pasan a «en espera» y se reanudan solas.
- Las conversiones (ffmpeg y LibreOffice) se ejecutan con prioridad baja (`nice 15`).
- La interfaz explica el caso: «El disco no responde», qué hacer y que lo guardado sigue a salvo.

## Consecuencias

- Un disco bloqueado se detecta en unos 20 s. Si sigue bloqueado, hay que reconectarlo físicamente (runbook en OPERATIONS §6 bis).
- Un disco SMR muy ocupado puede tardar en completar peticiones. Durante esos 20 s no se cambia de estado; si se superan, preferimos bloquear a arriesgar.
- La lectura de `/sys` solo existe en Linux. En otros sistemas el primer detector no actúa, pero el segundo sí.

## Alternativas descartadas

- **Leer un sector del disco con `O_DIRECT`:** requiere permisos sobre `/dev/sda` (el servicio no los tiene) y esa lectura también se colgaría.
- **Plazos por operación en la API:** no se pueden cancelar las llamadas al sistema de archivos en curso. Responder al cliente sin detener al guardián dejaría seguir enviando trabajo a un disco bloqueado.
