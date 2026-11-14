// Lista de recursos de ESTE build que el service worker guarda al instalar una versión nueva
// (public/sw.js). Así la app instalada arranca completa aunque no haya red: todas las páginas,
// no solo las ya visitadas (sin esto, una página nunca abierta dejaba la app en la pantalla de
// error de Nuxt, negra, al abrirla sin conexión).
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.output', 'public');
const names = await readdir(path.join(publicDir, '_nuxt'));
// JS, CSS y las fuentes del alfabeto latino (las de otros alfabetos se piden solo si hacen falta).
const assets = names
  .filter((name) => name.endsWith('.js') || name.endsWith('.css') || (name.endsWith('.woff2') && name.includes('-latin-')))
  .sort()
  .map((name) => `/_nuxt/${name}`);
// Manifiesto del build (Nuxt lo pide al arrancar): sin él, sin red, la app tampoco arranca.
const metaDir = path.join(publicDir, '_nuxt', 'builds', 'meta');
const metas = await readdir(metaDir).catch(() => []);
assets.push('/_nuxt/builds/latest.json', ...metas.filter((name) => name.endsWith('.json')).map((name) => `/_nuxt/builds/meta/${name}`));
await writeFile(path.join(publicDir, 'precache.json'), `${JSON.stringify({ assets })}\n`);
console.log(`precache.json: ${assets.length} recursos`);
