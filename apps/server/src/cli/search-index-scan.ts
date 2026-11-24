/**
 * Proceso aparte que recorre la raíz de datos para el índice de búsqueda (ADR-0029). Solo lee:
 * escribe el índice por la salida estándar y es el servidor quien lo guarda (con su lease).
 *
 *   node apps/server/src/cli/search-index-scan.ts <raíz de datos>
 *
 * Lo lanza el servicio con prioridad baja (nice 19, ionice «idle»); no está pensado para usarse a mano.
 */

import { scanTree, serializeIndex } from '../storage/search-index.ts';

const dataRoot = process.argv[2];
if (dataRoot === undefined || dataRoot === '') {
  process.stderr.write('uso: search-index-scan.ts <raíz de datos>\n');
  process.exit(2);
}

try {
  const data = await scanTree(dataRoot);
  process.stdout.write(serializeIndex(data), () => process.exit(0));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
