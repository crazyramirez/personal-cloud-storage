// Aplica una Content-Security-Policy estricta al HTML generado por `nuxt generate`.
//
// Nuxt incluye scripts en línea (configuración de arranque). En lugar de permitir 'unsafe-inline',
// se calcula el hash SHA-256 de cada script en línea de ESTE build y se declara en una etiqueta
// <meta http-equiv>. El proxy (Caddy) añade además las cabeceras que no pueden ir en <meta>
// (frame-ancestors, nosniff, referrer).
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.output', 'public');
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const DATA_TYPES = /type\s*=\s*["']?(application\/json|application\/ld\+json)/i;

async function htmlFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await htmlFiles(full)));
    else if (entry.name.endsWith('.html')) found.push(full);
  }
  return found;
}

const files = await htmlFiles(publicDir);
if (files.length === 0) throw new Error(`No hay HTML en ${publicDir}: ejecuta antes "nuxt generate"`);

for (const file of files) {
  let html = await readFile(file, 'utf8');
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, '');
  const hashes = new Set();
  for (const match of html.matchAll(SCRIPT)) {
    const [, attributes = '', body = ''] = match;
    if (/\bsrc\s*=/i.test(attributes) || DATA_TYPES.test(attributes) || body.trim() === '') continue;
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  const policy = [
    "default-src 'self'",
    `script-src 'self' ${[...hashes].join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'", // estilos en atributos (anchos de las barras de progreso)
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  // Tras <meta charset> (debe ir en los primeros bytes) y antes de cualquier script.
  if (/<meta charset="[^"]*">/i.test(html)) html = html.replace(/<meta charset="[^"]*">/i, (charset) => `${charset}${tag}`);
  else if (/<head[^>]*>/i.test(html)) html = html.replace(/<head([^>]*)>/i, `<head$1>${tag}`);
  else throw new Error(`${file} no tiene <head>`);
  if (html.indexOf(tag) > html.search(/<script\b/i)) throw new Error(`${file}: la CSP quedaría después de un script`);
  await writeFile(file, html);
  console.log(`CSP aplicada a ${path.relative(publicDir, file)} (${hashes.size} script(s) en línea con hash)`);
}
