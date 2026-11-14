# Pruebas de inyección de fallos

Las pruebas automáticas del guardián (`apps/server/test/storage/`) usan una sonda en memoria. Este directorio documenta las pruebas **físicas**, que se ejecutan siempre sobre un **volumen de laboratorio** (pendrive, disco viejo o imagen en RAM), nunca sobre un HDD con datos personales.

## F0-loop — Laboratorio con el kernel real, sin hardware extra

[`f0-loop-lab.sh`](f0-loop-lab.sh) crea dos imágenes exFAT de 64 MB en `/run/pcloud-lab` (tmpfs), las monta por loop en `/srv/pcloud` (solo si no hay nada montado) y comprueba 14 escenarios con el `pcloud-volume-status` real, ejecutado como `pcloud`: sin montar, onboarding, READY, marcador ajeno, tipo de FS, raíz de datos ausente, `ro`/`rw`, desmontaje, disco equivocado con el esperado presente o ausente, y protección del mountpoint vacío. Lo limpia todo al salir.

```bash
sudo bash /opt/pcloud/current/tests/fault-injection/f0-loop-lab.sh
```

Resultado en la Pi 4B (2026-11-13): **14 PASS, 0 FAIL**. Lo que no puede simular es la desconexión física (`DEVICE_ABSENT`): eso queda para F0 con hardware.

## F0 físico — Desconexión durante una escritura ([`f0-physical.sh`](f0-physical.sh))

Fases `prepare → load → (desenchufar) → observe → (enchufar) → recover → verify → cleanup`, como root, con el volumen vinculado y sin datos valiosos. El escritor usa el protocolo de commit: `.part` → fsync → rename → fsync del directorio. La verificación distingue entre datos perdidos y renombrados perdidos.

Resultados en la Pi 4B con el WD My Passport 5 TB (2026-11-13):

| | Ronda 1 | Ronda 2 (con ADR-0009) |
|---|---|---|
| Detección del guardián | `UNHEALTHY IO_ERROR` a los 0,28 s; `UNAVAILABLE NOT_MOUNTED` a los 1,8 s (systemd desmonta solo) | Igual |
| Escrituras en la microSD | 0 | 0 |
| Integridad de lo sincronizado | 13/13 ficheros con contenido íntegro; **1 rename perdido** | **43/43 íntegros, 0 renombrados perdidos** |
| Caché del disco | Sin vaciado (el kernel asumía *write through*) | Vaciado real; la regla udev se reaplica al reconectar |
| Tras reconectar | `fsck -n` limpio; VolumeDirty activo; systemd **no** remonta solo | Igual; VolumeDirty limpiado con `fsck.exfat -p` (autorizado) |

## F0 — Desconexión con el guardián vigilando (protocolo manual original)

Preparación: volumen de laboratorio formateado en Windows/macOS con el mismo FS elegido (exFAT o NTFS), montado en `/srv/pcloud` según la línea fstab sugerida. Dentro, `.pcloud/volume-id` y `data/` creados **a mano** solo en este volumen de pruebas:

```bash
# SOLO en el volumen de laboratorio, con él montado en /srv/pcloud:
ID=$(cat /proc/sys/kernel/random/uuid)
sudo -u pcloud mkdir -p /srv/pcloud/.pcloud /srv/pcloud/data
printf 'pcloud-volume-v1 %s\n' "$ID" | sudo -u pcloud tee /srv/pcloud/.pcloud/volume-id
echo "Marcador: $ID"
```

En una terminal:

```bash
node apps/server/src/cli/volume-status.ts --uuid <UUID> --fs-type <exfat|ntfs3|ntfs-3g> --marker <ID> --watch 1
```

| Paso | Acción | Resultado esperado |
|---|---|---|
| 1 | Situación inicial | `READY` |
| 2 | Desenchufar el USB **sin desmontar** | `UNAVAILABLE` en ≤ 2 s: `DEVICE_ABSENT` (montaje obsoleto) o `NOT_MOUNTED` (si systemd desmonta solo al desaparecer el dispositivo). Anotar cuál ocurre |
| 3 | Si sigue montado: `sudo umount /srv/pcloud` | `UNAVAILABLE NOT_MOUNTED`; `ls -A /srv/pcloud` vacío |
| 4 | `sudo -u pcloud touch /srv/pcloud/x` | Falla con *Permission denied* (mountpoint protegido) |
| 5 | Enchufar y `sudo mount /srv/pcloud` | `READY` con una **generación mayor** |
| 6 | Montar otro pendrive en `/srv/pcloud` | `WRONG_VOLUME SOURCE_MISMATCH` |
| 7 | `sudo mount -o remount,ro /srv/pcloud` | `READ_ONLY MOUNT_READ_ONLY` |
| 8 | Arrancar la Pi sin el disco | Arranca; `UNAVAILABLE`; nada escrito en la microSD |

Anota los resultados en `docs/HARDWARE_DISCOVERY.md`.

## Pendientes (S1.7)

T2 (desconexión durante una subida de 10 GiB), T3 (durante una descarga), T6 (NTFS sucio), T7 (crash entre staging y commit), T8 (corte de corriente, solo en el volumen de laboratorio).
