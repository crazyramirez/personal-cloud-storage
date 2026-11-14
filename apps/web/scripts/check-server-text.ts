/**
 * Comprueba que todo texto que el servidor envía al navegador (mensajes de AppError y avisos del
 * disco) tiene traducción al inglés en apps/web/app/utils/server-text.ts. Falla si se añade un
 * mensaje nuevo en el servidor sin traducirlo, o si una entrada exacta ya no existe en el servidor.
 * Uso: node apps/web/scripts/check-server-text.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXACT, PATTERNS } from '../app/utils/server-text.ts';

const serverSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    // cli/: mensajes de consola · onboarding: solo lo usa la CLI.
    if (statSync(full).isDirectory()) return name === 'cli' ? [] : walk(full);
    return name.endsWith('.ts') && !name.includes('onboarding') ? [full] : [];
  });
}

const translated = (message: string): boolean => message in EXACT || PATTERNS.some(([pattern]) => pattern.test(message));

// new AppError('CODE', '...') / `...` e issue('CODE', '...') / `...`
const CALL = /(?:new AppError|\bissue)\(\s*'([A-Z_]+)'\s*,\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/gs;
const problems: string[] = [];
const seen = new Set<string>();
let checked = 0;

for (const file of walk(serverSrc)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(CALL)) {
    const raw = match[2]!;
    const literal = raw.slice(1, -1);
    // Plantillas: se prueban con valores de ejemplo de texto y numéricos.
    const samples = raw.startsWith('`')
      ? [literal.replace(/\$\{[^}]*\}/g, 'x'), literal.replace(/\$\{[^}]*\}/g, '1'), literal.replace(/\$\{[^}]*\}/g, '/ruta/x')]
      : [literal.replace(/\\(.)/g, '$1')];
    for (const sample of samples) seen.add(sample);
    checked += 1;
    if (!samples.some(translated)) problems.push(`${file.slice(serverSrc.length + 1)}: sin traducción «${samples[0]}»`);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} texto(s) del servidor sin traducción en apps/web/app/utils/server-text.ts`);
  process.exit(1);
}
console.log(`Textos del servidor OK: ${checked} mensajes con traducción (${Object.keys(EXACT).length} exactos, ${PATTERNS.length} patrones)`);
