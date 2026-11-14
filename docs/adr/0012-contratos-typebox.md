# ADR-0012 — Contratos de la API con TypeBox

**Estado:** Aceptado · 2026-11-14

## Contexto

La API la usan el servidor (validación de entradas), la web y, más adelante, la app de escritorio (tipos). Si los tipos de TypeScript se escriben por un lado y la validación de entrada por otro, acaban divergiendo. El servidor se ejecuta sin build (type stripping, [ADR-0001](0001-monorepo-pnpm-typescript-nativo.md)) y no admite dependencias con binarios nativos ([ADR-0002](0002-node-26-modulos-nativos.md)).

## Decisión

- `packages/contracts/src/api.ts` define cada cuerpo, query y respuesta con **TypeBox** (`typebox` 1.x, JavaScript puro). Cada esquema es a la vez JSON Schema y un tipo estático (`Static<typeof X>`).
- El servidor pasa esos esquemas a Fastify (`schema: { body, querystring, params }`), que los valida con Ajv: `removeAdditional: false` y `useDefaults: false`. `coerceTypes` está activo porque la query llega como texto; afecta también al cuerpo JSON (`"5"` se aceptaría como `5`), lo que no abre rutas nuevas porque los valores se validan después igual. Un cuerpo con campos desconocidos o tipos incorrectos se rechaza con `400 VALIDATION_FAILED`, antes de llegar al código de ficheros.
- La web importa **solo tipos** (`import type`): TypeBox no llega al bundle del navegador.
- Los códigos de error (`errors.ts`) y los estados del volumen (`storage.ts`) son constantes compartidas. Cada código tiene un único estado HTTP.
- OpenAPI: se podrá generar desde los mismos esquemas cuando haga falta un cliente externo (fase 2). Hoy no se publica.

## Consecuencias

- Un cambio de contrato rompe la comprobación de tipos del servidor y de la web a la vez (`pnpm typecheck` y la build de Nuxt).
- Las reglas que no caben en JSON Schema se validan en el servidor, en `storage/names.ts` y `storage/paths.ts`: nombres portables (NFC, reservados de Windows, longitud en bytes) y rutas sin `..`, enlaces simbólicos ni cambios de dispositivo.

## Alternativas descartadas

- **Zod:** necesita un adaptador para Fastify y una conversión a JSON Schema, y su validación es más lenta que la de Ajv compilado.
- **Tipos a mano + validación manual:** dos fuentes de verdad que divergen.
- **Generar tipos desde OpenAPI:** añade un paso de build que el servidor no tiene.
