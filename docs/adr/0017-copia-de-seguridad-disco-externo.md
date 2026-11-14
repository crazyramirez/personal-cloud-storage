# ADR-0017: Copia de seguridad en un disco USB externo

Estado: Aceptado (2026-11-14)

## Contexto

La nube vive en un único disco. Si ese disco falla, se pierde todo. El propietario quiere una copia en un segundo disco USB que conecta de vez en cuando (≈ una vez a la semana), con un uso lo más sencillo posible: conectar, que la nube lo reconozca y sincronizar, sin pasos técnicos.

Restricciones:

- `pcloud.service` no tiene privilegios (sin sudo, `CapabilityBoundingSet=` vacío, `NoNewPrivileges`): no puede montar discos.
- El disco de copia, como el de datos, debe poder leerse en cualquier PC: exFAT o NTFS, archivos normales.
- El mandato principal (spec §3) se extiende a la copia: un disco ausente nunca puede interpretarse como «borrado», y nada puede escribirse en la tarjeta del sistema.
- Un fallo del disco de la nube (o un borrado accidental masivo) no debe propagarse a la copia.

## Decisión

1. **Agente root mínimo, separado del servidor.** `pcloud-backup-agent.sh` lo lanza systemd (`.path` sobre un buzón en `/var/lib/pcloud/backup-agent/inbox`). Solo entiende dos peticiones de una línea, `mount <UUID>` y `unmount <UUID>`, y responde con un código de un conjunto cerrado en `/run/pcloud-backup-agent` (root:pcloud 0640). Rechaza el disco de datos, el del sistema, cualquier sistema de archivos que no sea exFAT/NTFS y cualquier otro punto de montaje. Monta con las mismas opciones que el disco de datos (`nodev,nosuid,noexec`, uid/gid de `pcloud`, `errors=remount-ro`). Sin aislamiento de espacio de montajes: el montaje debe verse en el sistema. No hay sudo ni polkit.
2. **Punto de montaje protegido** `/srv/pcloud-backup` (root 0555 + inmutable), como `/srv/pcloud`: sin el disco de copia montado, nadie puede escribir ahí.
3. **Identidad del disco:** UUID del sistema de archivos + marca `.pcloud-backup/backup-id` (`pcloud-backup-v1 <uuid4>`), distinta de la del disco de datos. Detectar discos no los monta (`lsblk` lee sysfs y udev). Un disco con el UUID asignado pero otra marca se rechaza (`DISK_MISMATCH`).
4. **Espejo con archivo, nunca borrado directo.** La copia es un espejo de la raíz de datos en la carpeta «Personal Cloud Storage» del disco. Lo que sobra (borrado en la nube) y la versión anterior de lo modificado se **apartan** (rename) a `.pcloud-backup/archivo/<fecha>/…`. El archivo se borra al caducar (90 días por defecto, configurable) o, si falta sitio, empezando por lo más antiguo. El espejo nunca se borra para hacer sitio.
5. **Comparación por tamaño y fecha de modificación** (tolerancia 2 s). La fecha original se conserva en la copia, así que las siguientes sincronizaciones solo copian lo nuevo o cambiado.
6. **Durabilidad por lotes.** Cada archivo se copia a un temporal en su carpeta; al cerrar el lote (200 archivos, 512 MiB o 15 s), una orden `sync -f` vacía la caché del disco entero y solo entonces los temporales sustituyen a los finales. Un corte de luz nunca deja un archivo con nombre definitivo y contenido incompleto. No se paga un `fsync` por archivo (~60 ms en un HDD USB).
7. **Comprobaciones continuas.** Antes de cada archivo: `/srv/pcloud-backup` sigue siendo el dispositivo del UUID asignado (st_dev == st_rdev) y la nube sigue disponible. Un archivo que cambia mientras se copia se descarta (se copiará la próxima vez).
8. **Salvaguardas.** Si la nube aparece vacía y la copia no, o si la sincronización retiraría ≥ 100 archivos y ≥ 25 % de la copia, se pide confirmación antes de tocar nada.
9. **Desatendido.** Al conectar el disco asignado, la web pregunta si sincronizar; con «Sincronizar automáticamente» empieza sola. Al conectar otro disco compatible, ofrece asignarlo («este no es el disco de copia»). Al terminar, el disco se desmonta solo: se puede desconectar sin más. Si se desconecta a mitad, la siguiente sincronización continúa.
10. **Trazabilidad.** Historial en SQLite (`backup_runs`), auditoría y un informe JSON por sincronización en `.pcloud-backup/informes/`.

## Consecuencias

- Restaurar no necesita la nube: el disco de copia se lee en cualquier PC.
- Un borrado masivo en la nube no se propaga sin confirmación, y aun confirmado queda en el archivo hasta su caducidad.
- La copia es «al conectar», no continua: lo hecho entre conexiones no está protegido.
- En la Raspberry Pi, dos HDD alimentados solo por USB pueden superar la corriente disponible: la interfaz recomienda un disco con fuente propia o un hub alimentado.
- No se verifica el contenido con hashes (sería releer ambos discos enteros). Se confía en tamaño + fecha y en el vaciado de caché.

## Alternativas descartadas

- **rsync con `--delete`:** propaga borrados y fallos del disco origen; además, montar seguiría necesitando root.
- **sudoers o polkit para `pcloud`:** abre una vía de escalada desde el proceso expuesto a la red. El buzón con un agente de dos órdenes es más pequeño y auditable.
- **Automontaje de cualquier disco (udisks):** montaría discos ajenos sin que nadie lo pida.
- **Copias versionadas con deduplicación (restic, borg):** formato propietario; no se puede abrir el disco en un PC y ver los archivos.
