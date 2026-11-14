/**
 * Descargas.
 *
 * - Navegador normal: enlace temporal con «download» (el navegador gestiona la descarga y su
 *   reanudación).
 * - App instalada en móvil (iPhone/Android): hoja de compartir del sistema (Web Share con
 *   archivos), que ofrece «Guardar en Archivos», Fotos, AirDrop, otras apps… En la app instalada
 *   de iOS un enlace de descarga abre una vista previa sin salida; compartir es lo nativo.
 *   El archivo se descarga primero (con progreso) y luego se abre la hoja. Si el sistema exige un
 *   gesto nuevo (la descarga tardó), el aviso ofrece «Guardar…» para abrirla con un toque.
 *   Archivos muy grandes (más de SHARE_MAX_BYTES) usan la descarga normal para no agotar la memoria.
 */

const SHARE_MAX_BYTES = 512 * 1024 * 1024;

function linkDownload(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** ¿App instalada en un dispositivo táctil que puede compartir archivos? */
function canShareFiles(): boolean {
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  const installed = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  if (!installed || !matchMedia('(pointer: coarse)').matches) return false;
  try {
    return navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] });
  } catch {
    return false;
  }
}

/** Nombre del archivo según Content-Disposition (RFC 6266/5987), o el de reserva. */
function fileNameFrom(response: Response, fallback: string): string {
  const header = response.headers.get('content-disposition') ?? '';
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (encoded?.[1] !== undefined) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // nombre mal codificado: se prueba el simple
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || fallback;
}

/**
 * Tipo real por extensión: el servidor envía las descargas como octet-stream (fuerza descarga),
 * pero la hoja de compartir necesita el tipo para ofrecer, p. ej., «Guardar imagen» en Fotos.
 */
const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', aif: 'audio/aiff', aiff: 'audio/aiff',
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function mimeFor(name: string, header: string): string {
  if (header !== '' && header !== 'application/octet-stream') return header;
  const dot = name.lastIndexOf('.');
  return MIME[dot > 0 ? name.slice(dot + 1).toLowerCase() : ''] ?? 'application/octet-stream';
}

let sharing = false;

async function shareDownload(url: string, fallbackName: string): Promise<void> {
  if (sharing) return; // una a la vez: la hoja de compartir es modal
  sharing = true;
  const controller = new AbortController();
  const id = toast(t('ui.preparingDownload', { name: fallbackName }), {
    busy: true,
    action: { label: t('common.cancel'), run: () => controller.abort() },
  });
  try {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (!response.ok || response.body === null) throw new ApiError('INTERNAL', () => t('ui.downloadFailed'), response.status, true);
    const total = Number(response.headers.get('content-length') ?? 0);
    const name = fileNameFrom(response, fallbackName);
    if (total > SHARE_MAX_BYTES) {
      // Demasiado grande para pasar por memoria: descarga normal del navegador.
      controller.abort();
      dismissToast(id);
      linkDownload(url);
      return;
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let received = 0;
    let lastShown = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.byteLength;
      if (received > SHARE_MAX_BYTES) {
        controller.abort();
        dismissToast(id);
        linkDownload(url);
        return;
      }
      const now = performance.now();
      if (now - lastShown > 250) {
        lastShown = now;
        updateToast(id, {
          message: total > 0
            ? t('ui.downloadingPercent', { name, pct: Math.floor((received / total) * 100) })
            : t('ui.downloadingBytes', { name, size: formatBytes(received) }),
        });
      }
    }
    const type = mimeFor(name, response.headers.get('content-type')?.split(';')[0]?.trim() ?? '');
    const file = new File(parts as BlobPart[], name, { type });
    if (!navigator.canShare({ files: [file] })) {
      dismissToast(id);
      linkDownload(url);
      return;
    }
    const share = async (): Promise<void> => {
      try {
        await navigator.share({ files: [file] });
      } catch (error) {
        if ((error as DOMException)?.name === 'AbortError') return; // el usuario cerró la hoja
        throw error;
      }
    };
    try {
      await share();
      dismissToast(id);
    } catch (error) {
      if ((error as DOMException)?.name !== 'NotAllowedError') throw error;
      // La descarga tardó y el sistema pide un gesto nuevo: un toque en «Guardar…» abre la hoja.
      updateToast(id, {
        message: t('ui.downloadReady', { name }),
        busy: false,
        tone: 'ok',
        action: { label: t('ui.saveShare'), run: () => void share().catch(() => toast(t('ui.downloadFailed'), { tone: 'danger' })) },
      });
      setTimeout(() => dismissToast(id), 60_000);
    }
  } catch (error) {
    dismissToast(id);
    if ((error as DOMException)?.name === 'AbortError') return;
    toast(error instanceof Error && error.message !== '' ? error.message : t('ui.downloadFailed'), { tone: 'danger' });
  } finally {
    sharing = false;
  }
}

/** Nombre provisional de un ZIP (el definitivo lo pone el servidor, con el mismo formato). */
export function zipName(base = 'files'): string {
  const now = new Date();
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${base}-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}.zip`;
}

/**
 * Descarga un archivo o un ZIP. `name` es el nombre de reserva para el aviso de progreso (el real
 * llega en Content-Disposition).
 */
export function startDownload(url: string, name = ''): void {
  if (canShareFiles()) {
    void shareDownload(url, name || t('ui.downloadDefaultName'));
    return;
  }
  linkDownload(url);
}
