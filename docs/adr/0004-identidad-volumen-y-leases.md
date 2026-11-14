# ADR-0004 — Identidad del volumen: UUID + marcador + generación; leases

**Estado:** Aceptado · 2026-11-13

## Contexto

Hay que garantizar que se escribe en el disco correcto, que sigue montado y que no cambió durante una operación. El UUID de exFAT es un serial de 32 bits (clonable); un marcador copiado tampoco basta (§3.4.3).

## Decisión

1. **Dispositivo:** `/dev/disk/by-uuid/<UUID>` debe resolver a un dispositivo de bloques cuyo `rdev` (major:minor) coincida con el montaje visible en mountinfo. En FUSE (ntfs-3g), donde el montaje usa un dispositivo anónimo `0:N`, se compara la ruta real de la fuente.
2. **Vinculación:** `.pcloud/volume-id` con el formato `pcloud-volume-v1 <uuid-v4>`, que debe coincidir con `storage.volume_marker`. Lo escribe solo el onboarding.
3. **Generación:** un contador que aumenta con cada cambio de estado o de identidad (`mountId|major:minor|marcador`).
4. **Leases:** `assertWritableVolume()` devuelve un lease congelado con su generación; `revalidate(lease)` se llama inmediatamente antes de confirmar y falla si la generación cambió.
5. Detección de números de dispositivo con la codificación `makedev` de glibc (la que usa libuv/statx), verificada en tests.

## Consecuencias

- Una desconexión observada invalida las operaciones en vuelo aunque el disco vuelva.
- **Límite:** Linux reutiliza ids de montaje; un reenchufado completo entre dos sondeos (cada `health_check_interval_seconds`) podría pasar desapercibido. Mitigación obligatoria: verificar el fichero staged (longitud/hash) tras revalidar y antes de renombrar. Los ids de montaje únicos de 64 bits del kernel no están disponibles desde Node.
- Reinstalación o DB perdida: si el marcador del disco existe pero no está configurado, el estado es `NEEDS_CHECK NOT_ONBOARDED` con `detail.existingMarker` para readoptarlo de forma explícita.
