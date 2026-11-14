/**
 * Marca del disco de copia `.pcloud-backup/backup-id` (ADR-0017).
 *
 * Formato v1: `pcloud-backup-v1 <uuid-v4>` + salto opcional. El UUID del sistema de archivos dice
 * QUÉ disco es; la marca dice que es el disco de copia de ESTA nube (un UUID de exFAT son 32 bits
 * y puede repetirse). Es distinta de la marca del disco de datos (`.pcloud/volume-id`): un disco
 * nunca puede confundirse con el otro.
 */

const LINE = /^pcloud-backup-v1 ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\r?\n)?$/;

export const BACKUP_MARKER_FILE = 'backup-id';

export function parseBackupMarker(text: string): string | null {
  return LINE.exec(text)?.[1] ?? null;
}

export function formatBackupMarker(id: string): string {
  if (parseBackupMarker(`pcloud-backup-v1 ${id}`) === null) throw new TypeError(`Marca de copia inválida: ${id}`);
  return `pcloud-backup-v1 ${id}\n`;
}
