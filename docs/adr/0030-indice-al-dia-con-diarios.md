# ADR-0030: El índice de búsqueda se mantiene al día con los diarios de cambios

Estado: Aceptado (2026-11-24). Sustituye a los puntos 4 y 6 de [ADR-0029](0029-indice-de-busqueda.md) (renovación y búsqueda en directo).

## Contexto

ADR-0029 renovaba el índice recorriendo el disco entero cada 12 h y unos minutos después de cada cambio hecho desde la web. Lo copiado por la carpeta de red podía tardar hasta 12 h en aparecer. Spotlight (macOS) y Windows Search no funcionan así: recorren el disco una vez y después el sistema les avisa de cada cambio (FSEvents, diario USN de NTFS). En Linux, exFAT no ofrece un diario así y vigilar 50 000 carpetas con inotify es costoso. Pero en esta nube los cambios solo entran por dos vías, y ambas ya dejan constancia:

- **la web**: la propia aplicación hace cada operación;
- **la carpeta de red**: Samba anota cada escritura, carpeta creada y renombrado (full_audit), y `pcloud-smb-recent` lo guarda en `smb_recent` (ADR-0024).

## Decisión

1. **Lo nuevo desde la web** (subidas, carpetas y archivos creados) se añade al índice al momento, sin recorrer nada.
2. **Renombrar o mover desde la web** traslada la carpeta en el índice al instante, con todo su contenido: se guarda el traslado y se aplica al buscar, en los dos sentidos (lo que salió y lo que entró en la carpeta de la búsqueda). Sin recorrer.
3. **Copiar o restaurar una carpeta desde la web** añade la carpeta al momento; su contenido entra en el siguiente recorrido.
4. **La carpeta de red:** el servidor lee `smb_recent` cada 15 s y lo nuevo entra al índice al momento. Como por ahí también se renombra (y `smb_recent` no guarda el origen), además se programa un recorrido.
5. **El recorrido completo es la red de seguridad:** como mucho uno por hora cuando hay cambios que lo piden (puntos 3 y 4), con unos minutos de margen para agrupar, y uno al día en cualquier caso (cambios hechos por otras vías, como SSH).
6. **En directo**, a la vez que se comprueba lo del índice, se recorre la carpeta de la búsqueda durante 0,4 s: lo cercano.
7. Igual que antes: lo eliminado no hace falta quitarlo del índice, porque cada resultado se comprueba en el disco al buscar.

## Consecuencias

- Lo creado, subido, renombrado o movido desde la web, y lo que llega por la carpeta de red, aparece en la búsqueda en segundos.
- El contenido de una carpeta renombrada desde la carpeta de red, o copiada o restaurada desde la web, aparece tras el siguiente recorrido: menos de una hora y media.
- Lo cambiado por otras vías (SSH, el disco conectado a otro equipo) tarda como mucho un día. Al volver a conectar el disco, el índice se vuelve a cargar del propio disco.
