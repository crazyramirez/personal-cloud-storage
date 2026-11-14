# ADR-0009 — Durabilidad: vaciado de la caché del disco y fsync de directorios

**Estado:** Aceptado · 2026-11-13 · Origen: prueba F0 física, ronda 1

## Contexto

La primera prueba F0 (desenchufar el HDD durante una escritura) mostró dos fallos que contradicen el mandato principal:

1. **La caché del disco nunca se vaciaba.** El puente USB del WD My Passport (`1058:2626`, driver `usb-storage`) no expone la página de caché SCSI. El kernel registra *"No Caching mode page found — Assuming drive cache: write through"* y no envía `SYNCHRONIZE CACHE`. Sin embargo, la caché de escritura del disco **está activa** (`hdparm -W` = 1). Un `fsync` terminaba con los datos en la caché volátil, y un 2,5" alimentado por USB pierde la corriente al desenchufarlo.
2. **Se perdió un renombrado confirmado.** El escritor hizo `fsync` del fichero y luego `rename`, pero no sincronizó el directorio. Tras el corte, el fichero seguía con el nombre temporal `.part`. exFAT no tiene diario: la entrada de directorio del rename vivía solo en la caché de páginas.

## Decisión

- **Vaciado de caché real:** una regla udev ligada al número de serie ATA del disco fija `cache_type = "temporary write back"`. Cambia solo la visión del kernel, sin enviar MODE SELECT al disco, y desde ahí `fsync` emite `SYNCHRONIZE CACHE`. Script: `pcloud-disk-write-cache.sh`. Antes de darlo por bueno verifica que el puente acepta los vaciados sin errores.
- **Protocolo de commit obligatorio** para todo fichero que el sistema confirme (subidas, versiones, marcador, configuración):
  1. escribir en `.pcloud/staging/<id>.part`;
  2. `fsync` del fichero;
  3. `revalidate(lease)`;
  4. `rename` al destino;
  5. `fsync` del directorio destino;
  6. solo entonces, `COMMITTED` en SQLite.
- **Coste:** un vaciado real cuesta ~60 ms en este disco (SMR, 4800 rpm; 16 IOPS con fsync por cada 64 KiB). Las subidas **no** harán fsync por chunk: lo harán en el commit y en puntos de control (cada 64-128 MiB) que fijan el offset reanudable confirmado.
- El reconciliador (S1.4) trata un `COMMITTING` cuyo destino no existe pero cuyo `.part` está completo y con el hash esperado como "rehacer el rename", nunca como pérdida.

## Validación

F0 ronda 2, con ambas correcciones: **43/43 ficheros íntegros, 0 corruptos, 0 ausentes, 0 renombrados perdidos**. El fichero sin confirmar desapareció limpiamente. La regla udev se reaplicó sola al reconectar y al reiniciar.

## Consecuencias

- Cambiar de disco exige volver a ejecutar `pcloud-disk-write-cache.sh --serial <nueva serie>`.
- Si un puente futuro fallara con `SYNCHRONIZE CACHE`, el script lo detecta (errores en el registro del kernel) y se debe revertir; la alternativa sería desactivar la caché del disco (`hdparm -W0`), con una penalización grande en un disco SMR.
