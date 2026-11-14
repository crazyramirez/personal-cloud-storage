/**
 * Marcador de volumen `.pcloud/volume-id` (spec §3.2, §3.4.3).
 *
 * Formato v1: una sola línea `pcloud-volume-v1 <uuid-v4 en minúsculas>` + salto opcional.
 * Se tolera CRLF por si el fichero se toca desde Windows. Nada más se acepta.
 * El UUID del sistema de archivos identifica el dispositivo; el marcador identifica la
 * vinculación con ESTA instalación (los UUID de exFAT son seriales de 32 bits y pueden
 * clonarse o repetirse).
 */

const MARKER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MARKER_LINE = /^pcloud-volume-v1 ([0-9a-f-]{36})(?:\r?\n)?$/;

export const VOLUME_MARKER_MAX_BYTES = 1024;

export function isVolumeMarkerId(value: string): boolean {
  return MARKER_ID.test(value);
}

/** Devuelve el id o null si el contenido no es un marcador v1 válido. */
export function parseVolumeMarker(text: string): string | null {
  const match = MARKER_LINE.exec(text);
  const id = match?.[1];
  return id !== undefined && isVolumeMarkerId(id) ? id : null;
}

export function formatVolumeMarker(id: string): string {
  if (!isVolumeMarkerId(id)) throw new TypeError(`Identificador de volumen inválido: ${id}`);
  return `pcloud-volume-v1 ${id}\n`;
}
