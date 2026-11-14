# ADR-0003 — Modelo de estados del volumen y StorageGuardian que falla en cerrado

**Estado:** Aceptado · 2026-11-13

## Contexto

§3.4 enumera `INITIALIZING, READY, READ_ONLY, UNAVAILABLE, WRONG_VOLUME, NEEDS_CHECK, SCANNING`, pero el punto 6 bloquea también en `UNHEALTHY`, que no aparece en esa lista. `SCANNING` describe al indexador, no al disco.

## Decisión

- Estados del **volumen** (`packages/contracts/src/storage.ts`): `INITIALIZING, READY, READ_ONLY, UNAVAILABLE, WRONG_VOLUME, NEEDS_CHECK, UNHEALTHY`.
- El indexador tiene un estado independiente (`IDLE | SCANNING | PAUSED`, S1.6). Un volumen puede estar READY mientras se escanea.
- Cada estado no-READY lleva `issues[]` con un código estable (`VolumeIssueCode`) y un mensaje; `issues[0]` es la causa.
- **Fallo en cerrado:** READY solo tras demostrar positivamente las 12 condiciones de [STORAGE_CONTRACT §2](../STORAGE_CONTRACT.md). Las excepciones se clasifican (EIO → UNHEALTHY, EACCES → NEEDS_CHECK, resto → UNAVAILABLE).
- Solo READY permite mutaciones. Las lecturas se permiten en READY y READ_ONLY.
- Error de API: `503 STORAGE_UNAVAILABLE`, con `retryable` verdadero solo para UNAVAILABLE/UNHEALTHY y cambios de generación.

## Consecuencias

- Matriz de 37 fallos inyectados en tests; ninguno produce READY.
- La UI distingue "disco ausente" de "carpeta vacía" con datos estructurados, no con texto.
