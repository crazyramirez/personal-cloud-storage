# ADR-0025: Recientes agrupa lo copiado por la carpeta de red

Estado: Aceptado (2026-11-20). Modifica [ADR-0024](0024-recientes-de-la-carpeta-de-red.md) (puntos 4 y 5 y la primera consecuencia).

## Contexto

Con ADR-0024, una copia de DEV Backup Studio llenaba Recientes de archivos sueltos de un mismo proyecto (`src/…`, `_nuxt/…`), y también de su carpeta interna `.devbackup` (historial y versiones apartadas). Lo que interesa ver es qué se copió, no cada archivo.

## Decisión

1. **Se agrupa al mostrar, no al guardar.** `smb_recent` sigue guardando una fila por ruta (así los renombrados siguen retirando el origen). Al montar Recientes, cada ruta de la carpeta de red se recorta a `<carpeta compartida>/<ordenador>/<carpeta copiada>` (tres niveles, `smbRecentGroup`). Lo que está a ese nivel o por encima (un archivo suelto en la carpeta del ordenador) se muestra tal cual.
2. **La fecha del grupo es la de lo último que entró** en él.
3. **Lo oculto no se muestra:** una ruta con algún nombre que empieza por «.» (`.devbackup`, `.git`…) se omite. Son datos internos de la herramienta de copia o del proyecto.
4. **Se guardan 5000 filas** (antes 500) y se agrupa sobre todas: una sola copia escribe cientos de archivos y, con 500, la última copia tapaba a las anteriores. Siguen siendo unos cientos de KB en la base de datos.

## Consecuencias

- Una copia grande ocupa una sola entrada de Recientes por carpeta copiada.
- Una copia de más de 5000 archivos puede seguir tapando a las anteriores en Recientes. Es aceptable: lo último en entrar sigue siendo lo primero.
- Lo subido desde la web no cambia: se ve archivo a archivo, como antes.
