// Genera los iconos de la aplicación instalable (PWA) sin dependencias: geometría de la nube
// (círculos + rectángulo redondeado) rasterizada con supermuestreo y codificada como PNG.
//
//   node scripts/make-icons.mjs        → public/icons/*.png
//
// Los PNG se versionan en el repositorio; este script solo hace falta si cambia el diseño.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const TOP = [0x3b, 0x6c, 0xf0];
const BOTTOM = [0x1f, 0x42, 0xc0];

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Nube en coordenadas [0,1]: unión de tres círculos y una base redondeada. */
function insideCloud(x, y) {
  const circle = (cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  return (
    circle(0.355, 0.565, 0.155) ||
    circle(0.535, 0.455, 0.215) ||
    circle(0.70, 0.585, 0.135) ||
    insideRoundRect(x, y, 0.2, 0.5, 0.835, 0.72, 0.135)
  );
}

/**
 * @param size lado en píxeles
 * @param mode 'any' (esquinas redondeadas, transparente fuera) · 'maskable' (fondo completo, nube
 *             dentro de la zona segura del 80 %) · 'apple' (fondo completo, sin transparencia)
 */
function render(size, mode) {
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);
  const cloudScale = mode === 'maskable' ? 0.62 : mode === 'apple' ? 0.74 : 0.78;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let cloud = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          const inBg = mode === 'any' ? insideRoundRect(x, y, 0, 0, 1, 1, 0.225) : true;
          if (!inBg) continue;
          bg += 1;
          const cx = (x - 0.5) / cloudScale + 0.5;
          const cy = (y - 0.5) / cloudScale + 0.5 + 0.03;
          if (insideCloud(cx, cy)) cloud += 1;
        }
      }
      const total = samples * samples;
      const t = py / (size - 1);
      const base = TOP.map((top, i) => top + (BOTTOM[i] - top) * t);
      const c = cloud / Math.max(bg, 1);
      const offset = (py * size + px) * 4;
      pixels[offset] = Math.round(base[0] * (1 - c) + 255 * c);
      pixels[offset + 1] = Math.round(base[1] * (1 - c) + 255 * c);
      pixels[offset + 2] = Math.round(base[2] * (1 - c) + 255 * c);
      pixels[offset + 3] = Math.round((bg / total) * 255);
    }
  }
  return pixels;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits por canal
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // sin filtro
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(outDir, { recursive: true });
const outputs = [
  ['icon-192.png', 192, 'any'],
  ['icon-512.png', 512, 'any'],
  ['maskable-192.png', 192, 'maskable'],
  ['maskable-512.png', 512, 'maskable'],
  ['apple-touch-icon.png', 180, 'apple'],
  ['favicon-32.png', 32, 'any'],
];
for (const [name, size, mode] of outputs) {
  await writeFile(path.join(outDir, name), png(size, render(size, mode)));
  console.log(`icons/${name} (${size}px, ${mode})`);
}
