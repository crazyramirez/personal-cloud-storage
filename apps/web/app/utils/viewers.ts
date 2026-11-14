/**
 * Qué visor abre cada archivo (misma clasificación que el servidor, apps/server/src/media/media.ts).
 */

export type ViewerKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'office' | 'none';

const IMAGE_NATIVE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const IMAGE_CONVERT = new Set(['tif', 'tiff', 'heic', 'heif', 'jxl', 'tga', 'psd', 'dng', 'cr2', 'nef', 'arw', 'orf', 'rw2', 'pcx', 'ppm', 'pgm']);
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', 'mts', 'ts', '3gp', 'vob', 'divx', 'xvid', 'asf', 'rm', 'rmvb']);
const AUDIO = new Set(['mp3', 'm4a', 'aac', 'oga', 'ogg', 'opus', 'wav', 'flac', 'weba', 'wma', 'aiff', 'aif', 'ape', 'alac', 'amr', 'mka', 'ac3', 'dts', 'mid']);
const OFFICE = new Set(['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'pps', 'ppsx', 'odg', 'vsd', 'vsdx', 'pub', 'wpd', 'pages', 'numbers', 'key']);
const TEXT = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'jsonc', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'css', 'scss', 'less', 'html', 'htm', 'py', 'rb', 'php', 'java',
  'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'swift', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql', 'srt', 'vtt',
  'tex', 'gitignore', 'dockerfile', 'makefile', 'properties', 'gradle', 'lua', 'pl', 'r', 'dart',
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name.toLowerCase() : name.slice(dot + 1).toLowerCase();
}

export function viewerKind(name: string): ViewerKind {
  const ext = extensionOf(name);
  if (IMAGE_NATIVE.has(ext) || IMAGE_CONVERT.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (OFFICE.has(ext)) return 'office';
  if (TEXT.has(ext)) return 'text';
  return 'none';
}

/** La imagen la abre el navegador tal cual (si no, la convierte la Pi). */
export function isNativeImage(name: string): boolean {
  return IMAGE_NATIVE.has(extensionOf(name));
}

/** Tiene miniatura generada por el servidor: imágenes, vídeos y carátula de los audios. */
export function hasThumbnail(name: string): boolean {
  const kind = viewerKind(name);
  return (kind === 'image' && extensionOf(name) !== 'svg' && extensionOf(name) !== 'ico') || kind === 'video' || kind === 'audio';
}

/** Acción principal por tipo de visor (getters: siguen el idioma activo). */
export const VIEWER_LABEL: Record<ViewerKind, string> = {
  get image() {
    return t('viewers.image');
  },
  get video() {
    return t('viewers.video');
  },
  get audio() {
    return t('viewers.audio');
  },
  get pdf() {
    return t('viewers.pdf');
  },
  get text() {
    return t('viewers.text');
  },
  get office() {
    return t('viewers.office');
  },
  get none() {
    return t('viewers.none');
  },
};

/** Nombre sin extensión (para preseleccionar al renombrar, como en Windows). */
export function baseNameLength(name: string, isDir: boolean): number {
  if (isDir) return name.length;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? dot : name.length;
}
