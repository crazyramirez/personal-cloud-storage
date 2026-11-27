# ADR-0032 — Reparación automática del disco tras un corte de luz

**Estado:** Aceptado · 2026-11-27 · Origen: incidente en la Pi (disco en solo lectura tras un corte de luz)

## Contexto

El 2026-11-26 el equipo se quedó sin corriente con el disco montado. Al volver, el kernel avisó: *«Volume was not properly unmounted»*. Veinte segundos después, el índice de búsqueda recorrió una carpeta cuyo directorio había crecido justo antes del corte. Tenía un clúster más en la FAT de lo que decía su tamaño, y el kernel lo detectó (*«bogus directory size (clus : ondisk(10) != counted(11))»*). Por `errors=remount-ro` pasó el disco a solo lectura (READ_ONLY, `MOUNT_READ_ONLY`).

Reiniciar no lo arreglaba: en el siguiente arranque se volvía a montar con escritura y, a los 38 s, otra vez solo lectura. `fsck.exfat -n` encontró **una** carpeta dañada entre 531.721 ficheros (una pasada completa tarda ~5 min en el WD de 5 TB).

Hasta ahora la política era: el sistema **nunca** repara, y la reparación es una decisión humana (OPERATIONS §6). El propietario pide lo contrario: el servidor debe aguantar un corte de luz y, al reiniciar, reparar solo cualquier problema, sin intervención. Es una nube doméstica para personas no técnicas; un disco en solo lectura hasta que alguien entre por SSH equivale a una nube rota.

## Decisión

**El sistema comprueba y repara el sistema de archivos del disco de datos él solo, y siempre con el disco desmontado.**

1. **Antes de cada montaje** (`pcloud-volume-repair.service`, que `srv-pcloud.mount` pide con un drop-in `Wants=`/`After=`):
   - exFAT: se leen los VolumeFlags del sector de arranque (2 bytes, solo lectura). Si `VolumeDirty` o `MediaFailure` están activos, se ejecuta `fsck.exfat -y -s`. Si corrigió algo, se verifica con `fsck.exfat -n`. Si el disco se desmontó bien, no se ejecuta nada y no hay espera.
   - NTFS: `ntfsfix -n` en cada montaje (son segundos) y, si avisa, `ntfsfix -d`.
   - Si no queda limpio (errores sin corregir, error de E/S o más de 4 h), se monta **en solo lectura**: se puede ver y descargar, y no se escribe sobre un sistema de archivos dañado.
   - Termina siempre con éxito. Si la comprobación no pudiera ni arrancar, el disco se monta igual y el StorageGuardian sigue vigilando.
2. **Con el equipo en marcha** (`pcloud-volume-agent.{path,service}`, agente root mínimo como en ADR-0017/0020): cuando el guardián entra en READ_ONLY por `MOUNT_READ_ONLY`, `pcloud.service` deja un aviso vacío en `/var/lib/pcloud/volume-agent/inbox`. El agente:
   - comprueba por su cuenta que hace falta: el disco vinculado está montado en `ro` y `/etc/fstab` pide `rw`;
   - para Samba (y `pcloud.service` solo si el disco sigue ocupado), desmonta y vuelve a montar, lo que pasa por el punto 1;
   - vuelve a arrancar lo que haya parado;
   - se limita a 3 reparaciones en 24 h. No lo reintenta en el mismo arranque si la reparación ya no dejó el disco limpio: repetirla no cambia nada (disco dañado o alimentación). Reiniciar lo vuelve a intentar.
3. **Nada se descarta.** `-s` guarda en `/LOST+FOUND` los clústeres que quedan sin fichero, fuera de la nube. Las reparaciones solo tocan metadatos del sistema de archivos: no formatean, no particionan y no borran ficheros de la nube. La salida completa queda en `/var/log/pcloud-volume-repair.log`.
4. **La web lo explica.** El estado (`/run/pcloud-volume-repair/status.json`, solo de este arranque) sale en `GET /system/storage` como `repair` (`pending | running | done | failed` y el resultado). Mientras dura: «Reparando el disco…» en vez de «Disco no disponible». Si falla: «No se ha podido reparar el disco», con qué hacer.
5. `check-scripts.sh` sigue rechazando `fsck`/`ntfsfix` de reparación en cualquier script. La única excepción son las líneas de `pcloud-volume-repair.sh` marcadas con `# pcloud-lint: allow-fsck-repair (ADR-0032)`.

Sustituye la regla de OPERATIONS §6 «reparar solo con una decisión explícita» para el disco de datos. Los asistentes de IA siguen sin ejecutar reparaciones a mano (AGENTS.md, regla 1): la reparación la hace el sistema, con este procedimiento.

## Alternativas descartadas

- **`fsck` en `/etc/fstab` (campo 6 = 2, `systemd-fsck`):** revisaría el disco en cada arranque (5 min aunque se apagara bien). Además, si `fsck` falla, el montaje falla y el disco queda inaccesible del todo.
- **`mount -o remount,rw` sin `fsck`:** deja la incoherencia en el disco. El kernel vuelve a ponerlo en solo lectura en cuanto la toca y, entre tanto, se escribe sobre un sistema de archivos dañado.
- **`fsck.exfat -p` (solo reparaciones «seguras»):** no corrige un directorio con más clústeres que su tamaño, que es justo el daño típico de un corte de luz.

## Consecuencias

- Tras un corte de luz, la nube tarda unos minutos más en volver: ~5 min de comprobación si está bien y ~10 si hubo que reparar. Mientras tanto, la web dice «Reparando el disco…».
- Si el disco ya venía sucio, el primer `-y` limpio también borra la marca VolumeDirty, que Linux no borra si estaba puesta al montar. Desde ahí, los arranques tras un apagado correcto no comprueban nada.
- `fsck -y` puede truncar un directorio a su tamaño anotado. Los ficheros cuyas entradas estaban en el clúster sobrante pierden el nombre, pero sus datos quedan en `/LOST+FOUND`. El propietario pidió que la nube vuelva sola, y esto es lo mismo que haría una persona.
- Si se apaga el equipo durante una reparación, systemd espera a que termine (`TimeoutStopSec=30min`) en vez de cortarla. Un corte de luz a mitad deja la marca sucia: se repite en el siguiente arranque.
- Un disco que se daña una y otra vez (alimentación) acaba en solo lectura con «No se ha podido reparar». El sistema no se queda en un bucle de reparaciones.
- El soporte NTFS (`ntfsfix`) es limitado por naturaleza y no se ha probado en la Pi: solo un `chkdsk` de Windows repara NTFS de verdad.
