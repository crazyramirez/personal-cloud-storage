/** Formato de tamaños, fechas y tipos de archivo para la interfaz (en el idioma activo). */

type IntlAny = Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.Collator;
const cache = new Map<string, IntlAny>();
function cached<T extends IntlAny>(kind: string, options: object, make: (tag: string) => T): T {
  const tag = intlLocale();
  const key = `${kind}|${tag}|${JSON.stringify(options)}`;
  let value = cache.get(key) as T | undefined;
  if (value === undefined) {
    value = make(tag);
    cache.set(key, value);
  }
  return value;
}

/** Formateadores Intl del idioma activo (cacheados; reactivos al cambiar de idioma). */
export const numberFormat = (options: Intl.NumberFormatOptions = {}): Intl.NumberFormat => cached('n', options, (tag) => new Intl.NumberFormat(tag, options));
export const dateFormat = (options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => cached('d', options, (tag) => new Intl.DateTimeFormat(tag, options));
export const relativeFormat = (options: Intl.RelativeTimeFormatOptions = { numeric: 'auto' }): Intl.RelativeTimeFormat => cached('r', options, (tag) => new Intl.RelativeTimeFormat(tag, options));
export const collator = (options: Intl.CollatorOptions = { numeric: true, sensitivity: 'base' }): Intl.Collator => cached('c', options, (tag) => new Intl.Collator(tag, options));

/** Número con el formato del idioma activo (p. ej. 1.234,5 / 1,234.5). */
export function formatNumber(value: number, maximumFractionDigits = 1): string {
  return numberFormat({ maximumFractionDigits }).format(value);
}

/** Tiempo relativo («hace 5 minutos» / «5 minutes ago»); más de 30 días: fecha. */
export function formatRelative(iso: string): string {
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(seconds);
  const rtf = relativeFormat();
  if (abs < 60) return t('common.justNow');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86_400 * 30) return rtf.format(Math.round(seconds / 86_400), 'day');
  return formatDate(iso);
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Tamaños en base 1024, como los muestra el Explorador de Windows. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatter = numberFormat({ maximumFractionDigits: unit >= 4 ? 2 : 1 });
  return `${unit === 0 ? Math.round(value) : formatter.format(value)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : '';
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : dateFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return t('common.remainingS', { s: Math.ceil(seconds) });
  if (seconds < 3600) return t('common.remainingMS', { m: Math.floor(seconds / 60), s: Math.round(seconds % 60) });
  return t('common.remainingHM', { h: Math.floor(seconds / 3600), m: Math.round((seconds % 3600) / 60) });
}

export type FileIconName = 'folder' | 'doc' | 'image' | 'video' | 'archive' | 'audio';

const KINDS: Array<{ icon: FileIconName; label: string; extensions: string[] }> = [
  { icon: 'image', label: 'common.image', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg', 'raw', 'dng'] },
  { icon: 'video', label: 'common.video', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'mpg', 'mpeg', 'wmv'] },
  { icon: 'audio', label: 'common.audio', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'opus', 'aif', 'aiff'] },
  { icon: 'archive', label: 'common.archive', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'] },
];
/** Claves de traducción por extensión. */
const LABELS: Record<string, string> = {
  pdf: 'common.pdf', txt: 'common.txt', md: 'common.md', doc: 'common.word', docx: 'common.word',
  xls: 'common.spreadsheet', xlsx: 'common.spreadsheet', csv: 'common.csv', ppt: 'common.presentation', pptx: 'common.presentation',
  odt: 'common.document', ods: 'common.spreadsheet', json: 'common.json', html: 'common.html',
};

export function fileKind(name: string, type: 'dir' | 'file'): { icon: FileIconName; label: string } {
  if (type === 'dir') return { icon: 'folder', label: t('common.folder') };
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const kind = KINDS.find((candidate) => candidate.extensions.includes(extension));
  if (kind !== undefined) return { icon: kind.icon, label: t(kind.label, { ext: extension.toUpperCase() }) };
  const label = LABELS[extension];
  if (label !== undefined) return { icon: 'doc', label: t(label) };
  return { icon: 'doc', label: extension === '' ? t('common.file') : t('common.fileExt', { ext: extension.toUpperCase() }) };
}

/** Enlace del explorador para una ruta del cliente (`/Proyectos/Web` → `/archivos/Proyectos/Web`). */
export function explorerLink(segments: readonly string[]): string {
  return segments.length === 0 ? '/archivos' : `/archivos/${segments.map(encodeURIComponent).join('/')}`;
}
