/**
 * Índice de nombres para el cuadro de búsqueda (ADR-0029).
 *
 * Recorrer el disco entero en cada búsqueda no es viable: en la Raspberry Pi, un exFAT con medio
 * millón de elementos tarda más de 5 minutos en recorrerse (el coste es del propio núcleo, no de
 * la aplicación). Como Windows y macOS, se mantiene un índice:
 *
 *  - Lo genera un proceso aparte (cli/search-index-scan.ts) con prioridad baja de CPU y de disco,
 *    que SOLO LEE y entrega la lista por la salida estándar. No escribe nada.
 *  - Se guarda como caché regenerable en el propio disco de datos (`.pcloud/cache/search/`),
 *    nunca en la microSD, y solo con el volumen escribible y el mismo lease de principio a fin.
 *    Al arrancar se carga de ahí: la búsqueda funciona desde el primer momento.
 *  - Se mantiene al día como Spotlight o Windows Search, con los diarios de cambios que ya hay
 *    (ADR-0030): lo creado desde la web y lo que anota Samba de la carpeta de red entra al momento;
 *    renombrar o mover desde la web traslada la carpeta en el índice sin recorrer nada. El recorrido
 *    completo queda como red de seguridad: una vez al día y, si la carpeta de red tuvo actividad
 *    (puede haber renombrado algo), como mucho una vez por hora.
 *  - Es solo una pista: cada resultado se comprueba en el disco antes de devolverlo (storage/
 *    search.ts). Un índice viejo nunca muestra algo que ya no existe, y una ausencia en el índice
 *    nunca se trata como un borrado.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errnoOf } from '../errors.ts';
import { ensureCacheDir } from '../media/media.ts';
import { formatClientPath, isReservedTopName, parseClientPath } from './paths.ts';
import { foldForSearch } from './search.ts';
import type { VolumeLease } from './storage-guardian.ts';

/** Lo que guarda el índice: cada elemento con el índice de su carpeta (-1 = la raíz de datos). */
export interface IndexData {
  readonly builtAt: string;
  readonly names: readonly string[];
  readonly parents: readonly number[];
  /** 1 = carpeta, 0 = archivo. */
  readonly kinds: readonly number[];
}

const FORMAT = 1;
const INDEX_DIR = 'search';
const INDEX_FILE = 'index-v1.json';

/**
 * Recorre el árbol por niveles, solo leyendo y sin seguir enlaces (lo usa el proceso aparte).
 * Las carpetas que no se pueden leer se saltan; un error de E/S del disco corta el recorrido.
 */
export async function scanTree(dataRoot: string, options: { signal?: AbortSignal; now?: () => Date } = {}): Promise<IndexData> {
  const names: string[] = [];
  const parents: number[] = [];
  const kinds: number[] = [];
  const queue: Array<{ abs: string; index: number }> = [{ abs: dataRoot, index: -1 }];
  for (let head = 0; head < queue.length; head++) {
    if (options.signal?.aborted === true) throw new Error('recorrido cancelado');
    const dir = queue[head] as { abs: string; index: number };
    let dirents;
    try {
      dirents = await readdir(dir.abs, { withFileTypes: true });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(errnoOf(error) ?? '')) continue;
      throw error;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory() && !dirent.isFile()) continue;
      if (dir.index === -1 && isReservedTopName(dirent.name)) continue;
      const index = names.length;
      names.push(dirent.name);
      parents.push(dir.index);
      kinds.push(dirent.isDirectory() ? 1 : 0);
      if (dirent.isDirectory()) queue.push({ abs: path.join(dir.abs, dirent.name), index });
    }
  }
  return { builtAt: (options.now ?? (() => new Date()))().toISOString(), names, parents, kinds };
}

export function serializeIndex(data: IndexData): string {
  return JSON.stringify({ format: FORMAT, ...data });
}

/** null si el contenido no es un índice válido (versión distinta, dañado, incoherente). */
export function parseIndex(text: string): IndexData | null {
  try {
    const raw = JSON.parse(text) as Partial<IndexData> & { format?: unknown };
    if (raw.format !== FORMAT || typeof raw.builtAt !== 'string' || !Array.isArray(raw.names) || !Array.isArray(raw.parents) || !Array.isArray(raw.kinds)) return null;
    const n = raw.names.length;
    if (raw.parents.length !== n || raw.kinds.length !== n) return null;
    for (let i = 0; i < n; i++) {
      const parent = raw.parents[i];
      if (typeof raw.names[i] !== 'string' || typeof parent !== 'number' || parent < -1 || parent >= i) return null;
    }
    return { builtAt: raw.builtAt, names: raw.names, parents: raw.parents, kinds: raw.kinds };
  } catch {
    return null;
  }
}

/** Índice en memoria preparado para buscar: nombres sin mayúsculas ni acentos en un solo texto. */
export class NameIndex {
  readonly builtAt: string;
  readonly size: number;
  readonly #names: readonly string[];
  readonly #parents: Int32Array;
  readonly #kinds: Uint8Array;
  /** Nombres plegados separados por «\n»: buscar es un indexOf nativo sobre un único texto. */
  readonly #haystack: string;
  readonly #offsets: Int32Array;
  /** «<carpeta padre>\0<nombre>» → índice, solo carpetas (para situar la carpeta de la búsqueda). */
  readonly #dirs = new Map<string, number>();

  constructor(data: IndexData) {
    this.builtAt = data.builtAt;
    this.size = data.names.length;
    this.#names = data.names;
    this.#parents = Int32Array.from(data.parents);
    this.#kinds = Uint8Array.from(data.kinds);
    this.#offsets = new Int32Array(this.size + 1);
    const parts: string[] = new Array<string>(this.size);
    let offset = 0;
    for (let i = 0; i < this.size; i++) {
      const name = data.names[i] as string;
      // Nombres ASCII (casi todos): basta con minúsculas, mucho más rápido que normalizar.
      const folded = /^[\x20-\x7e]*$/.test(name) ? name.toLowerCase() : foldForSearch(name);
      parts[i] = folded;
      this.#offsets[i] = offset;
      offset += folded.length + 1;
      if (data.kinds[i] === 1) this.#dirs.set(`${data.parents[i]}\u0000${name}`, i);
    }
    this.#offsets[this.size] = offset;
    this.#haystack = parts.join('\n') + '\n';
  }

  /** Índice de la carpeta (-1 = raíz), o null si no está en el índice (p. ej. creada después). */
  #locate(segments: readonly string[]): number | null {
    let index = -1;
    for (const segment of segments) {
      const next = this.#dirs.get(`${index}\u0000${segment}`);
      if (next === undefined) return null;
      index = next;
    }
    return index;
  }

  #entryAt(position: number): number {
    let lo = 0;
    let hi = this.size - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.#offsets[mid] as number) <= position) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  #segmentsOf(index: number): string[] {
    const segments: string[] = [];
    for (let i = index; i !== -1; i = this.#parents[i] as number) segments.push(this.#names[i] as string);
    return segments.reverse();
  }

  /**
   * Coincidencias dentro de la carpeta `segments` (incluidas sus subcarpetas), lo más cercano
   * primero. null si esa carpeta no está en el índice. `tokens` ya vienen plegados.
   */
  find(segments: readonly string[], tokens: readonly string[], cap = 20_000): string[][] | null {
    const root = this.#locate(segments);
    if (root === null) return null;
    if (tokens.length === 0) return [];
    const longest = [...tokens].sort((a, b) => b.length - a.length)[0] as string;
    const hits: Array<{ index: number; depth: number }> = [];
    let position = this.#haystack.indexOf(longest);
    while (position !== -1 && hits.length < cap) {
      const index = this.#entryAt(position);
      const start = this.#offsets[index] as number;
      const end = (this.#offsets[index + 1] as number) - 1;
      const folded = this.#haystack.slice(start, end);
      if (tokens.every((token) => folded.includes(token))) {
        // ¿Está dentro de la carpeta de la búsqueda? Se sube por sus carpetas hasta ella (o hasta la
        // raíz de datos, -1). `depth` = niveles por debajo de la carpeta de la búsqueda.
        let depth = 0;
        let inside = false;
        for (let i = this.#parents[index] as number; ; i = this.#parents[i] as number) {
          if (i === root) {
            inside = true;
            break;
          }
          if (i === -1) break;
          depth += 1;
        }
        if (inside) hits.push({ index, depth });
      }
      position = this.#haystack.indexOf(longest, end + 1);
    }
    hits.sort((a, b) => a.depth - b.depth || (this.#kinds[b.index] as number) - (this.#kinds[a.index] as number));
    return hits.map((hit) => this.#segmentsOf(hit.index));
  }
}

/** Cambia el prefijo `from` por `to` si la ruta es esa carpeta o algo de dentro. */
function rebase(clientPath: string, from: string, to: string): string {
  if (clientPath === from) return to;
  return clientPath.startsWith(`${from}/`) ? `${to}${clientPath.slice(from.length)}` : clientPath;
}

// ── Servicio: carga, renovación y lo cambiado ───────────────────────────────────────────────

export interface IndexGate {
  readonly current: { readonly state: string; readonly generation: number };
  assertReadableVolume(): Promise<VolumeLease>;
  assertWritableVolume(): Promise<VolumeLease>;
  revalidate(lease: VolumeLease): Promise<void>;
}

export type IndexScanner = (dataRoot: string, signal: AbortSignal) => Promise<IndexData>;

export interface SearchIndexOptions {
  readonly gate: IndexGate;
  /** Por defecto, el proceso aparte con prioridad baja (cli/search-index-scan.ts). */
  readonly scanner?: IndexScanner;
  /** Renovar si el índice tiene más de esto. */
  readonly maxAgeMs?: number;
  /** Margen tras un cambio desde la web antes de renovar (se agrupan los cambios seguidos). */
  readonly settleMs?: number;
  /** Separación mínima entre dos renovaciones. */
  readonly minGapMs?: number;
  /** Espera tras arrancar antes del primer recorrido (que el equipo termine de arrancar). */
  readonly startDelayMs?: number;
  /**
   * Diario de cambios hechos fuera de la web (la carpeta de red, smb_recent): rutas anotadas
   * después de `since` (ISO) y la marca de la última. Se consulta cada pocos segundos.
   */
  readonly changes?: ((since: string) => { paths: string[]; last: string | null }) | undefined;
  readonly changesEveryMs?: number;
  readonly now?: () => number;
  readonly log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

export type IndexState = 'ready' | 'building' | 'none';

const HOUR = 60 * 60 * 1000;
/** Rutas añadidas que se recuerdan hasta el siguiente recorrido; si se llena, se renueva antes. */
const MAX_ADDED = 50_000;
const MAX_RENAMES = 2_000;

export class SearchIndex {
  readonly #o: Required<Omit<SearchIndexOptions, 'log' | 'changes'>> & Pick<SearchIndexOptions, 'log' | 'changes'>;
  #index: NameIndex | null = null;
  #scanning: AbortController | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #periodic: ReturnType<typeof setInterval> | null = null;
  #lastScanEnd = 0;
  #dirty = false;
  #loadedGeneration: number | null = null;
  #loading: Promise<void> | null = null;
  /** Rutas creadas o cambiadas después del último recorrido (aún no indexadas). */
  #added = new Set<string>();
  /** Carpetas renombradas o movidas desde la web después del último recorrido, en orden. */
  #renames: Array<{ from: string; to: string; at: number }> = [];
  #changesTimer: ReturnType<typeof setInterval> | null = null;
  /** Marca de lo último leído del diario de la carpeta de red. */
  #changesSince: string | null = null;

  constructor(options: SearchIndexOptions) {
    this.#o = {
      scanner: scanInChildProcess,
      maxAgeMs: 24 * HOUR,
      settleMs: 3 * 60_000,
      minGapMs: HOUR,
      startDelayMs: 60_000,
      changesEveryMs: 15_000,
      now: Date.now,
      ...options,
    };
  }

  get state(): IndexState {
    if (this.#index !== null) return 'ready';
    return this.#scanning !== null ? 'building' : 'none';
  }

  get builtAt(): string | null {
    return this.#index?.builtAt ?? null;
  }

  get index(): NameIndex | null {
    return this.#index;
  }

  /** Lo creado aún sin indexar (para buscarlo también). */
  get added(): ReadonlySet<string> {
    return this.#added;
  }

  /**
   * Busca en el índice teniendo en cuenta lo renombrado o movido desde la web después del último
   * recorrido: la carpeta de la búsqueda se traduce a su ruta antigua y los resultados a la nueva.
   */
  find(segments: readonly string[], tokens: readonly string[]): string[][] | null {
    const index = this.#index;
    if (index === null) return null;
    if (this.#renames.length === 0) return index.find(segments, tokens);
    const asPath = formatClientPath(segments);
    const prefix = asPath === '/' ? '/' : `${asPath}/`;
    const back = (p: string): string => [...this.#renames].reverse().reduce((acc, rename) => rebase(acc, rename.to, rename.from), p);
    const forward = (p: string): string => this.#renames.reduce((acc, rename) => rebase(acc, rename.from, rename.to), p);
    // Dónde estaba en el índice lo que ahora hay en la carpeta: la propia carpeta (con su nombre
    // antiguo) y el origen de todo lo que se trasladó a ella o dentro de ella.
    const sources = new Set<string>([back(asPath)]);
    for (const rename of this.#renames) {
      if (rename.to === asPath || rename.to.startsWith(prefix)) sources.add(back(rename.to));
    }
    let any = false;
    const seen = new Set<string>();
    const results: string[][] = [];
    for (const source of sources) {
      const found = index.find(parseClientPath(source), tokens);
      if (found === null) continue;
      any = true;
      for (const hit of found) {
        const p = forward(formatClientPath(hit));
        // Lo que se movió fuera de la carpeta de la búsqueda ya no está en ella.
        if (!p.startsWith(prefix) || seen.has(p)) continue;
        seen.add(p);
        results.push(parseClientPath(p));
      }
    }
    if (!any) return index.find(segments, tokens); // la carpeta se creó después del índice
    results.sort((a, b) => a.length - b.length);
    return results;
  }

  /** Renombrar o mover desde la web: el índice lo traslada al instante (sin recorrer nada). */
  relocated(from: string, to: string): void {
    try {
      const rename = { from: formatClientPath(parseClientPath(from)), to: formatClientPath(parseClientPath(to)), at: this.#o.now() };
      if (rename.from === rename.to || rename.from === '/') return;
      this.#renames.push(rename);
      this.#added.add(rename.to);
      if (this.#renames.length > MAX_RENAMES) {
        this.#renames.shift();
        this.#markDirty(); // ya no se puede seguir el rastro de todo: mejor recorrer
      }
    } catch {
      // ruta no válida: nada que trasladar
    }
  }

  /** Comprobación periódica: carga el guardado al estar el disco y renueva si toca. */
  start(): void {
    this.#periodic = setInterval(() => void this.tick(), HOUR);
    this.#periodic.unref?.();
    this.#schedule(this.#o.startDelayMs);
    if (this.#o.changes !== undefined) {
      this.#changesTimer = setInterval(() => this.pollChanges(), this.#o.changesEveryMs);
      this.#changesTimer.unref?.();
    }
  }

  /** Lee el diario de la carpeta de red: lo nuevo entra al índice al momento. */
  pollChanges(): void {
    if (this.#o.changes === undefined) return;
    // La primera vez, desde que se hizo el índice (lo anterior ya está en él).
    const since = this.#changesSince ?? this.#index?.builtAt ?? new Date(this.#o.now()).toISOString();
    try {
      const { paths, last } = this.#o.changes(since);
      this.#changesSince = last ?? since;
      if (paths.length === 0) return;
      // Por la carpeta de red también se renombra y se mueve, y eso no se puede seguir desde
      // aquí: se renueva el índice (como mucho una vez por hora).
      this.touched(paths, { rescan: true });
    } catch (error) {
      this.#o.log?.warn({ err: error }, 'no se pudo leer el diario de la carpeta de red');
    }
  }

  stop(): void {
    if (this.#changesTimer !== null) clearInterval(this.#changesTimer);
    if (this.#periodic !== null) clearInterval(this.#periodic);
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#scanning?.abort();
  }

  /**
   * Rutas creadas o cambiadas: se buscan desde ya. `rescan`: además hay que recorrer (p. ej. se
   * copió o restauró una carpeta con contenido que el índice no tiene); se agrupan los cambios.
   */
  touched(clientPaths: readonly string[], options: { rescan?: boolean } = {}): void {
    let full = false;
    for (const p of clientPaths) {
      if (this.#added.size >= MAX_ADDED) {
        full = true;
        break;
      }
      try {
        this.#added.add(formatClientPath(parseClientPath(p)));
      } catch {
        // ruta no válida: nada que recordar
      }
    }
    if (options.rescan === true || full) this.#markDirty();
  }

  #markDirty(): void {
    this.#dirty = true;
    if (this.#scanning !== null) return; // se renovará al terminar el recorrido en curso
    const wait = Math.max(this.#o.settleMs, this.#lastScanEnd + this.#o.minGapMs - this.#o.now());
    this.#schedule(wait);
  }

  #schedule(ms: number): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.tick();
    }, Math.max(0, ms));
    this.#timer.unref?.();
  }

  /**
   * Carga el índice guardado en el disco si no está en memoria (o el volumen cambió). Es rápido
   * (~1 s con medio millón de elementos): se llama en cuanto el disco está listo, sin esperar a la
   * primera renovación.
   */
  ensureLoaded(): Promise<void> {
    const state = this.#o.gate.current.state;
    if (state !== 'READY' && state !== 'READ_ONLY') return Promise.resolve();
    if (this.#index !== null && this.#loadedGeneration === this.#o.gate.current.generation) return Promise.resolve();
    this.#loading ??= this.#load().finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  /** Carga el índice guardado si no hay uno en memoria y renueva si es viejo o hubo cambios. */
  async tick(): Promise<void> {
    const state = this.#o.gate.current.state;
    if (state !== 'READY' && state !== 'READ_ONLY') return;
    await this.ensureLoaded();
    const age = this.#index === null ? Infinity : this.#o.now() - Date.parse(this.#index.builtAt);
    if (this.#scanning === null && (age > this.#o.maxAgeMs || this.#dirty)) await this.rebuild();
  }

  async #load(): Promise<void> {
    try {
      const lease = await this.#o.gate.assertReadableVolume();
      const text = await readFile(path.join(lease.internalDir, 'cache', INDEX_DIR, INDEX_FILE), 'utf8');
      await this.#o.gate.revalidate(lease);
      const data = parseIndex(text);
      this.#loadedGeneration = lease.generation;
      if (data === null) return;
      if (this.#index !== null && data.builtAt <= this.#index.builtAt) return; // el de memoria es igual o más nuevo
      this.#index = new NameIndex(data);
      this.#o.log?.info({ entries: this.#index.size, builtAt: this.#index.builtAt }, 'índice de búsqueda cargado');
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') this.#loadedGeneration = this.#o.gate.current.generation; // aún no hay índice guardado
      else this.#o.log?.warn({ err: error }, 'no se pudo cargar el índice de búsqueda');
    }
  }

  /** Recorre el disco (proceso aparte), lo guarda en la caché del disco y lo pone en uso. */
  async rebuild(): Promise<void> {
    if (this.#scanning !== null) return;
    const controller = new AbortController();
    this.#scanning = controller;
    this.#dirty = false;
    const addedBefore = new Set(this.#added);
    const started = this.#o.now();
    try {
      const lease = await this.#o.gate.assertReadableVolume();
      const data = await this.#o.scanner(lease.dataRoot, controller.signal);
      // El disco tiene que ser el mismo de principio a fin: si cambió, el resultado no vale.
      await this.#o.gate.revalidate(lease);
      this.#index = new NameIndex(data);
      this.#loadedGeneration = lease.generation;
      for (const p of addedBefore) this.#added.delete(p);
      // Lo renombrado antes de empezar el recorrido ya está en él con su nombre nuevo.
      this.#renames = this.#renames.filter((rename) => rename.at > started);
      this.#o.log?.info({ entries: data.names.length, ms: this.#o.now() - started }, 'índice de búsqueda renovado');
      await this.#persist(data);
    } catch (error) {
      if (!controller.signal.aborted) this.#o.log?.warn({ err: error }, 'no se pudo renovar el índice de búsqueda');
    } finally {
      this.#scanning = null;
      this.#lastScanEnd = this.#o.now();
      if (this.#dirty) this.#schedule(Math.max(this.#o.settleMs, this.#o.minGapMs));
    }
  }

  /** Caché regenerable en el disco de datos: solo con el volumen escribible; si no, se queda en memoria. */
  async #persist(data: IndexData): Promise<void> {
    try {
      const lease = await this.#o.gate.assertWritableVolume();
      const cacheDir = path.join(lease.internalDir, 'cache');
      await ensureCacheDir(cacheDir); // nunca crea `.pcloud`: sin disco montado, falla
      const dir = path.join(cacheDir, INDEX_DIR);
      await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
        if (errnoOf(error) !== 'EEXIST') throw error;
      });
      const tmp = path.join(dir, `${INDEX_FILE}.${process.pid}.tmp`);
      await this.#o.gate.revalidate(lease);
      await writeFile(tmp, serializeIndex(data), { mode: 0o600 });
      await rename(tmp, path.join(dir, INDEX_FILE));
    } catch (error) {
      this.#o.log?.warn({ err: error }, 'no se pudo guardar el índice de búsqueda en el disco');
    }
  }
}

/**
 * Recorrido en un proceso aparte, con prioridad baja de CPU (nice 19) y de disco (ionice «idle»
 * si existe), para no frenar subidas ni la web. Entrega el índice por la salida estándar.
 */
export function scanInChildProcess(dataRoot: string, signal: AbortSignal): Promise<IndexData> {
  const script = path.resolve(import.meta.dirname, '../cli/search-index-scan.ts');
  const run = (useIonice: boolean): Promise<IndexData> =>
    new Promise((resolve, reject) => {
      const args = [process.execPath, script, dataRoot];
      const child = useIonice ? spawn('ionice', ['-c3', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(args[0] as string, args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let stderr = '';
      const abort = (): void => {
        child.kill('SIGKILL');
      };
      signal.addEventListener('abort', abort, { once: true });
      child.on('spawn', () => {
        if (child.pid !== undefined) {
          try {
            os.setPriority(child.pid, 19);
          } catch {
            // sin permiso: prioridad normal
          }
        }
      });
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString();
      });
      child.on('error', (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      });
      child.on('close', (code) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) return reject(new Error('recorrido cancelado'));
        if (code !== 0) return reject(new Error(`el recorrido terminó con el código ${code}: ${stderr.trim()}`));
        const data = parseIndex(Buffer.concat(chunks).toString('utf8'));
        if (data === null) return reject(new Error('el recorrido no devolvió un índice válido'));
        resolve(data);
      });
    });
  // Sin ionice (no instalado o no permitido), se lanza igual, solo con nice.
  return run(true).catch((error: unknown) => (signal.aborted ? Promise.reject(error) : run(false)));
}
