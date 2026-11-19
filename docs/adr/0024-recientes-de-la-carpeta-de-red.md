# ADR-0024: Recientes incluye lo copiado por la carpeta de red

Estado: Aceptado (2026-11-19). Amplía [ADR-0021](0021-carpeta-de-red-smb.md).

## Contexto

«Recientes» (Panel) sale del registro de actividad (`audit_log`): subidas, carpetas y archivos creados desde la web. Lo que los ordenadores copian por la carpeta de red (SMB, DEV Backup Studio) lo escribe Samba directamente en el disco y no pasa por la API, así que no aparecía.

Alternativas descartadas:

- **Recorrer la carpeta y ordenar por fecha.** Las copias tienen muchísimos archivos: recorrerla tarda minutos y carga el disco (la Pi ya ha tenido bloqueos del disco bajo carga). Además, las herramientas de copia suelen conservar la fecha de modificación original, que no dice cuándo se copió.
- **inotify sobre la carpeta.** Necesita un vigilante por cada subcarpeta (miles) y recorrer el árbol entero al arrancar.
- **Dar al servidor web acceso al diario del sistema.** Vería todos los registros del equipo.

## Decisión

1. **Samba lo registra.** La carpeta compartida (y sus alias) carga el módulo `full_audit` con solo las operaciones correctas `mkdirat`, `renameat` y `create_file`, al diario del sistema (`smbd_audit`, facility LOCAL5). Ni lecturas, ni borrados, ni fallos.
2. **Un servicio aparte lo recoge.** `pcloud-smb-recent.service` corre como `pcloud` con el grupo `systemd-journal`, sigue `journalctl` filtrado por `smbd_audit` y guarda cada ruta en la tabla `smb_recent` (ruta → fecha del evento) de la base de datos. El servidor web no lee el diario. El servicio guarda el cursor de `journalctl` con cada lote: al reiniciarse no pierde ni repite líneas. Nunca toca el disco de datos.
3. **Qué cuenta.** Carpetas creadas, archivos creados o reescritos (`create`, `overwrite`, `overwrite_if`, `supersede`, u `open_if` con permiso de escritura) y el destino de un renombrado (el origen se retira). Se ignoran listar carpetas, temporales (`~$…`, `.tmp`, `.part`…), `Thumbs.db`, `desktop.ini`, `.DS_Store`, flujos alternativos (`:`) y lo que caiga fuera de la raíz de datos o en rutas reservadas.
4. **Acotado y aparte de Actividad.** `smb_recent` guarda una fila por ruta y conserva las 500 más recientes. Actividad no se llena con miles de líneas por copia.
5. **Recientes mezcla las dos fuentes** por fecha y, como antes, solo muestra lo que sigue existiendo en esa ruta.
6. **Sin cortar copias.** `pcloud-install-smb.sh` instala el servicio y, con smbd en marcha, recarga su configuración en vez de reiniciarlo. `pcloud-deploy-release.sh` reinicia el servicio con cada release (`try-restart`).

## Consecuencias

- Una copia grande llena Recientes con sus últimos archivos: es lo último que entró en la nube.
- journald limita los mensajes por servicio (10 000 cada 30 s por defecto). En una copia de muchos archivos pequeños pueden perderse líneas: Recientes mostrará parte de ellos. No afecta a la copia.
- Las líneas ocupan espacio en el diario del sistema (en la microSD si el diario es persistente), dentro de los límites de tamaño de journald.
- Lo que se copió antes de activar esto no aparece.
