/**
 * Sonda en memoria que simula /proc/self/mountinfo, /dev/disk/by-uuid y el árbol del
 * volumen. Permite inyectar fallos (EIO, EROFS, EACCES...) por operación y ruta.
 * Los tests del StorageGuardian NUNCA tocan discos reales.
 */

import type { DeviceNumber } from '../../src/storage/device-number.ts';
import type { BlockStats, PathInfo, PathKind, StorageProbe } from '../../src/storage/probe.ts';

export type ProbeOp = 'readMountInfo' | 'lstat' | 'stat' | 'realpath' | 'readTextFile' | 'checkWritable';

export interface FakeNode {
  kind: PathKind;
  dev: DeviceNumber;
  rdev?: DeviceNumber;
  /** Solo para symlink: destino absoluto. */
  target?: string;
  /** Solo para file. */
  content?: string;
}

interface Failure {
  readonly op: ProbeOp;
  readonly path: string;
  readonly error: unknown;
}

export function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} (simulado)`), { code });
}

export class FakeProbe implements StorageProbe {
  mountinfo = '';
  readonly nodes = new Map<string, FakeNode>();
  readonly calls: Array<{ op: ProbeOp; path: string }> = [];
  #failures: Failure[] = [];
  /** Si se define, readMountInfo espera a esta promesa (para probar concurrencia). */
  gate: Promise<void> | null = null;
  /** Contadores del dispositivo de bloques (null = no disponibles, como en Windows). */
  blockStats: BlockStats | null = null;
  /** Si se define, lstat espera a esta promesa: simula un disco que deja de responder. */
  lstatGate: Promise<void> | null = null;

  async readBlockStats(_device: DeviceNumber): Promise<BlockStats | null> {
    return this.blockStats;
  }

  /** Programa un fallo; `error` puede ser un código errno o cualquier valor a lanzar. */
  fail(op: ProbeOp, path: string, error: string | unknown): this {
    this.#failures.push({ op, path, error: typeof error === 'string' ? errno(error) : error });
    return this;
  }

  clearFailures(): this {
    this.#failures = [];
    return this;
  }

  set(path: string, node: FakeNode): this {
    this.nodes.set(path, node);
    return this;
  }

  delete(...paths: string[]): this {
    for (const path of paths) this.nodes.delete(path);
    return this;
  }

  #enter(op: ProbeOp, path: string): void {
    this.calls.push({ op, path });
    const failure = this.#failures.find((entry) => entry.op === op && entry.path === path);
    if (failure !== undefined) throw failure.error;
  }

  #resolve(path: string): { path: string; node: FakeNode } | null {
    let current = path;
    for (let hops = 0; hops < 8; hops++) {
      const node = this.nodes.get(current);
      if (node === undefined) return null;
      if (node.kind !== 'symlink') return { path: current, node };
      current = node.target ?? '';
    }
    throw errno('ELOOP');
  }

  #info(node: FakeNode): PathInfo {
    return {
      kind: node.kind,
      dev: node.dev,
      rdev: node.rdev ?? { major: 0, minor: 0 },
      size: BigInt(node.content === undefined ? 0 : Buffer.byteLength(node.content)),
    };
  }

  async readMountInfo(): Promise<string> {
    if (this.gate !== null) await this.gate;
    this.#enter('readMountInfo', '/proc/self/mountinfo');
    return this.mountinfo;
  }

  async lstat(path: string): Promise<PathInfo | null> {
    if (this.lstatGate !== null) await this.lstatGate;
    this.#enter('lstat', path);
    const node = this.nodes.get(path);
    return node === undefined ? null : this.#info(node);
  }

  async stat(path: string): Promise<PathInfo | null> {
    this.#enter('stat', path);
    const resolved = this.#resolve(path);
    return resolved === null ? null : this.#info(resolved.node);
  }

  async realpath(path: string): Promise<string | null> {
    this.#enter('realpath', path);
    return this.#resolve(path)?.path ?? null;
  }

  async readTextFile(path: string, maxBytes: number): Promise<string> {
    this.#enter('readTextFile', path);
    const node = this.nodes.get(path);
    if (node === undefined) throw errno('ENOENT');
    if (node.kind === 'symlink') throw errno('ELOOP');
    if (node.kind !== 'file') throw errno('EISDIR');
    const content = node.content ?? '';
    if (Buffer.byteLength(content) > maxBytes) throw errno('EFBIG');
    return content;
  }

  async checkWritable(path: string): Promise<void> {
    this.#enter('checkWritable', path);
    if (!this.nodes.has(path)) throw errno('ENOENT');
  }
}
