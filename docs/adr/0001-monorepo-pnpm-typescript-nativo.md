# ADR-0001 — Monorepo pnpm y TypeScript ejecutado con type stripping de Node

**Estado:** Aceptado · 2026-11-13

## Contexto

La spec pide monorepo (`apps/`, `packages/`), TypeScript strict, un SDK y contratos compartidos con la web y Electron, y despliegues simples en una SBC. Node 26 ejecuta `.ts` directamente eliminando los tipos (type stripping), sin transpilar.

## Decisión

- Gestor **pnpm** con workspaces (`pnpm-workspace.yaml`), versión fijada en `packageManager`. Sin pnpm global: `npx pnpm@12.18.0 …` o `npm i -g pnpm@12.18.0`.
- El **backend se ejecuta desde el código TypeScript** (`node src/…ts`), sin paso de build. `tsc` (TypeScript 7) solo comprueba tipos (`noEmit`).
- Solo sintaxis "borrable": `erasableSyntaxOnly`, `verbatimModuleSyntax`, imports con extensión `.ts`. Nada de `enum`, `namespace` ni parameter properties; se usan uniones de literales `as const`.
- Los paquetes internos exportan su fuente `.ts` (`"exports": { ".": "./src/index.ts" }`); pnpm los enlaza y Node los resuelve por su ruta real (fuera de `node_modules`).
- Tests con `node --test` integrado.
- Despliegue futuro con `pnpm deploy --prod` para generar un directorio autocontenido por aplicación.

## Consecuencias

- Lo que se despliega es lo que se audita: no hay bundles ni source maps intermedios.
- Requiere Node ≥ 22.18 en el servidor; se fija Node 26 (ADR-0002).
- La web (Nuxt) y Electron tendrán su propio build; consumen `packages/*` como fuente TS sin problema.

## Alternativas

- npm workspaces: no requiere herramienta extra, pero no ofrece un equivalente a `pnpm deploy` y no protege frente a dependencias fantasma.
- Compilar con `tsc` a `dist/`: añade un paso y artefactos sin aportar nada en un servidor propio.
