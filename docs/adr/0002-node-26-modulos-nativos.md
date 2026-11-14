# ADR-0002 — Node 26 LTS y módulos integrados: sin dependencias con binarios nativos

**Estado:** Aceptado · 2026-11-13

## Contexto

La spec (§4) advierte del riesgo de los bindings nativos de SQLite en ARM64 y pide justificar cada dependencia. Node 26 ("Lithium", LTS) incluye:

- `node:sqlite` (`DatabaseSync`, `backup()`), sin advertencia experimental en 26.x;
- `crypto.argon2` / `argon2Sync` (Argon2id vía OpenSSL 3.5);
- `node:test`, type stripping, `fs.statfs`, `util.parseArgs`.

Comprobado en el índice oficial: Node 26 publica `linux-arm64` y **no** `linux-armv7l`.

## Decisión

- Runtime **Node 26 LTS** en servidor y desarrollo (`engines: >=26`, `.node-version`).
- SQLite mediante `node:sqlite`; hash de contraseñas con `crypto.argon2` (Argon2id).
- **Cero dependencias de runtime con código nativo.** Dependencias actuales:

| Paquete | Tipo | Motivo | Huella ARM64 | Alternativa estándar |
|---|---|---|---|---|
| `yaml@2.9.1` | runtime | La configuración es YAML (spec §3.2, §13); comentarios útiles en un fichero de operación | JS puro, 0 dependencias | JSON: sin comentarios |
| `typescript@7.0.2` | dev | Comprobación de tipos | Solo en desarrollo | — |
| `@types/node@26.6.6` | dev | Tipos de Node | Solo en desarrollo | — |

- Previstas para S1.1, con su propio ADR: `fastify` (JS puro) y la librería de validación de contratos.

## Consecuencias

- El SO de la Pi debe tener **userland arm64** (ver ADR-0008).
- `pnpm install` en la Pi no compila nada: no hacen falta `build-essential` ni `node-gyp`.
- Si `node:sqlite` o `crypto.argon2` dieran problemas en arm64: `better-sqlite3` (tiene prebuilds arm64) y `crypto.scrypt`, cada uno con su ADR.
