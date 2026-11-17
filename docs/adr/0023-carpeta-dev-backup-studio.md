# ADR-0023: La carpeta de red se llama DEV_Backup_Studio y lleva su icono

Estado: Aceptado (2026-11-18). Sustituye en parte a [ADR-0021](0021-carpeta-de-red-smb.md): el nombre de la carpeta compartida.

## Contexto

La carpeta de red de ADR-0021 se llamaba `Copias`. En la nube se mezcla con las carpetas del usuario y no deja claro que son las copias de seguridad que hace DEV Backup Studio en los ordenadores. Cuando se tomó la decisión ya había ordenadores conectados a `\<host>\Copias\<equipo>` y copias guardadas dentro.

## Decisión

1. **Nombre por defecto: `DEV_Backup_Studio`** (`pcloud-install-smb.sh`). Sigue siendo configurable con `--name`. La nube publica el nombre en `/etc/pcloud/smb.json` y se lo entrega al ordenador al emparejarlo (ADR-0022), así que DEV Backup Studio no lo tiene escrito en su código.
2. **Cambio de nombre sin perder nada.** Si `smb.json` tenía otro nombre (p. ej. `Copias`):
   - La carpeta se **renombra** en el mismo disco con `mv -T` como `pcloud`: no se copia ni se borra nada.
   - Si ya existen las dos carpetas, el script no toca ninguna y pide juntarlas a mano.
   - Se **conserva la contraseña** de `pcloud-smb`.
   - El nombre antiguo queda como **alias oculto** (`browseable = no`) de la misma carpeta, guardado en `smb.json` (`aliases`). Los ordenadores ya conectados a `\<host>\Copias` siguen funcionando sin tocar nada. Los nuevos se emparejan con el nombre nuevo.
3. **Icono propio en la web.** La carpeta `DEV_Backup_Studio` de la raíz de la nube se muestra con el icono de DEV Backup Studio: la silueta de carpeta con su degradado violeta→cian y las flechas de sincronización (`DbsFolderIcon.vue`). Aparece en el explorador (lista, iconos y detalles), en Recientes y en el selector de carpetas.

## Consecuencias

- La carpeta sigue protegida (no se puede borrar, mover ni renombrar desde la web). El nombre protegido sale de `smb.json`, así que el cambio no exige tocar el servidor.
- El alias se mantiene mientras siga en `smb.json`. Para quitarlo: borrar la entrada de `aliases` y repetir `pcloud-install-smb.sh --execute`; los ordenadores que aún usen el nombre antiguo tendrán que volver a emparejarse.
- El icono va por nombre (raíz de la nube y `DEV_Backup_Studio`). Con un nombre personalizado (`--name`) la carpeta se ve con el icono normal.
