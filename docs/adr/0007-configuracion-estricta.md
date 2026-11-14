# ADR-0007 — Configuración YAML estricta sin opciones inseguras

**Estado:** Aceptado · 2026-11-13

## Decisión

- `/etc/pcloud/config.yaml` (ejemplo: `deploy/config/config.example.yaml`), validado por `apps/server/src/config/config.ts` sin librerías de esquemas.
- Las claves y secciones desconocidas y los YAML con claves duplicadas son **error de arranque**, con la ruta exacta.
- Se **eliminan** las opciones de la spec que solo permitirían estados inseguros, con un mensaje explicativo:
  - `storage.on_missing_volume`: sin volumen siempre se rechazan las mutaciones;
  - `security.require_auth`: la autenticación es obligatoria.
- Se rechazan los marcadores de posición de la spec (`exfat_or_ntfs3`, `REEMPLAZAR…`). `expected_fs_uuid` y `volume_marker` admiten `null` (instalación sin configurar o sin vincular → `NEEDS_CHECK`).
- `paths.state_dir` (SQLite) no puede estar dentro del mountpoint del HDD.
- Se añade `storage.min_free_bytes` (por defecto 10 GiB). Se reserva el mayor entre ese valor y `min_free_percent`.
- Se añade `storage.health_check_interval_seconds` (5 s) para el sondeo del guardián.

## Consecuencias

Una errata nunca desactiva una protección en silencio.
