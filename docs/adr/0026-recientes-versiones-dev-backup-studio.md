# ADR-0026: Las versiones apartadas por DEV Backup Studio cuentan en Recientes

Estado: Aceptado (2026-11-20). Modifica [ADR-0025](0025-recientes-agrupa-la-carpeta-de-red.md) (punto 3).

## Contexto

ADR-0025 omite de Recientes todo lo oculto, incluida la carpeta interna `.devbackup` de DEV Backup Studio. Pero ahí, en `<compartida>/.devbackup/versiones/<fecha>/<ordenador>/<carpeta>/…`, la app aparta lo que se modifica o se borra en cada copia. Una carpeta del ordenador en la que solo se modificaron o borraron archivos no aparecía en Recientes.

## Decisión

Una ruta bajo `<compartida>/.devbackup/versiones/<fecha>/` se cuenta como la misma ruta sin ese prefijo y se agrupa como el resto: `<compartida>/<ordenador>/<carpeta>`. Las carpetas de la fecha y del ordenador solas no cuentan. Lo demás que es oculto (`.devbackup/historial.jsonl`, `.git`…) se sigue omitiendo, también dentro de las versiones.

## Consecuencias

- Recientes muestra las carpetas del ordenador que cambiaron en la copia, tanto si llegaron archivos nuevos como si solo se modificaron o borraron.
- Depende de la estructura de carpetas de DEV Backup Studio. Si cambia, esas versiones vuelven a omitirse (como cualquier otra ruta oculta); nunca se muestra nada de más.
