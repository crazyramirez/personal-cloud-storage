/**
 * Comprueba las traducciones de la web:
 *  1. Cada diccionario app/i18n/<espacio>.ts tiene las mismas claves en español e inglés y ninguna vacía.
 *  2. Toda clave literal usada con t('espacio.clave') existe.
 * Uso: node apps/web/scripts/check-i18n.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const problems: string[] = [];
const known = new Set<string>();

for (const file of readdirSync(join(root, 'i18n')).filter((name) => name.endsWith('.ts'))) {
  const namespace = file.slice(0, -3);
  const module = (await import(pathToFileURL(join(root, 'i18n', file)).href)) as { default: { es: Record<string, unknown>; en: Record<string, unknown> } };
  const { es, en } = module.default;
  for (const key of Object.keys(es)) {
    known.add(`${namespace}.${key}`);
    if (!(key in en)) problems.push(`${file}: falta «${key}» en inglés`);
  }
  for (const key of Object.keys(en)) if (!(key in es)) problems.push(`${file}: «${key}» solo existe en inglés`);
  for (const [lang, table] of [['es', es], ['en', en]] as const) {
    for (const [key, value] of Object.entries(table)) {
      if (typeof value === 'string' ? value.trim() === '' : typeof value !== 'function') problems.push(`${file}: «${key}» vacía o inválida (${lang})`);
    }
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'i18n' ? [] : walk(full);
    return /\.(vue|ts)$/.test(name) ? [full] : [];
  });
}

let uses = 0;
for (const file of walk(root)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\b(?:t\(\s*|errorText\([^;\n]*?,\s*)'([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)'/g)) {
    uses += 1;
    if (!known.has(match[1]!)) problems.push(`${file.slice(root.length + 1)}: clave inexistente «${match[1]}»`);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problema(s) de traducción`);
  process.exit(1);
}
console.log(`Traducciones OK: ${known.size} claves, ${uses} usos literales`);
