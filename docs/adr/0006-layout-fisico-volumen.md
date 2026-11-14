# ADR-0006 — `.pcloud/` en la raíz del FS; raíz administrada elegida en onboarding

**Estado:** Aceptado · 2026-11-13

## Decisión

- `/srv/pcloud/.pcloud/{staging,trash,versions,volume-id}` siempre en la **raíz del FS** del HDD. Staging, papelera y versiones viven en el mismo volumen que los datos, de modo que mover entre ellos es un rename y nunca se escribe en la microSD.
- `storage.root_relative` (por defecto `data`) lo fija el onboarding:
  - (a) volumen vacío → crear `data/`;
  - (b) importar una carpeta concreta → copia o movimiento explícito, revisado, dentro de `data/`;
  - (c) administrar una raíz existente → `root_relative` apunta a ella (puede ser `"."`).
- La raíz administrada nunca puede estar dentro de `.pcloud/` ni salir del volumen (validado en la configuración y en el guardián).
- Con `"."` se excluyen `.pcloud/` y las carpetas de sistema de Windows/macOS ([STORAGE_CONTRACT §5](../STORAGE_CONTRACT.md)).
- Sin enlaces simbólicos para disimular diferencias de layout.

## Consecuencias

- El disco sigue siendo legible tal cual desde Windows/macOS; `.pcloud/` aparece como una carpeta oculta en macOS y como carpeta normal en Windows.
