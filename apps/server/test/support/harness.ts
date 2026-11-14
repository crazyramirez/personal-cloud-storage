/**
 * Banco de pruebas del servidor: un "volumen" en un directorio temporal real (con `.pcloud/` y
 * `data/`), una puerta de volumen falsa cuyo estado y generación se controlan desde el test, y
 * SQLite en memoria. Nunca toca discos reales.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { VolumeState } from '@pcloud/contracts';
import { validateConfig, type PcloudConfig } from '../../src/config/config.ts';
import { openDatabase, type Db } from '../../src/db/database.ts';
import type { GuardianLike } from '../../src/http/app.ts';
import { StorageUnavailableError, type LeaseKind, type VolumeLease, type VolumeSnapshot } from '../../src/storage/storage-guardian.ts';
import { FsOperations, type FsOperationsOptions } from '../../src/storage/operations.ts';
import { SerialQueue } from '../../src/storage/serial.ts';
import { UploadManager, type UploadManagerOptions } from '../../src/storage/uploads.ts';

export class FakeGate implements GuardianLike {
  state: VolumeState = 'READY';
  generation = 1;
  revalidations = 0;
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  get current(): VolumeSnapshot {
    return {
      state: this.state,
      issues: this.state === 'READY' ? [] : [{ code: 'DEVICE_ABSENT', message: 'El disco configurado no está conectado' }],
      generation: this.generation,
      checkedAt: '2026-11-14T10:00:00.000Z',
      mount: null,
      identity: `fake|${this.generation}`,
    };
  }

  #lease(kind: LeaseKind): VolumeLease {
    return Object.freeze({
      kind,
      generation: this.generation,
      mountPoint: this.root,
      internalDir: path.join(this.root, '.pcloud'),
      dataRoot: path.join(this.root, 'data'),
    });
  }

  #fail(): never {
    throw new StorageUnavailableError(`El disco configurado no está disponible (estado ${this.state})`, this.current);
  }

  async check(): Promise<VolumeSnapshot> {
    return this.current;
  }

  async assertWritableVolume(): Promise<VolumeLease> {
    if (this.state !== 'READY') this.#fail();
    return this.#lease('write');
  }

  async assertReadableVolume(): Promise<VolumeLease> {
    if (this.state !== 'READY' && this.state !== 'READ_ONLY') this.#fail();
    return this.#lease('read');
  }

  async revalidate(lease: VolumeLease): Promise<void> {
    this.revalidations += 1;
    if (lease.generation !== this.generation) this.#fail();
    if (lease.kind === 'write' && this.state !== 'READY') this.#fail();
  }

  /** Simula desenchufar el disco: cambia el estado y la generación. */
  disconnect(): void {
    this.state = 'UNAVAILABLE';
    this.generation += 1;
  }

  /** Simula volver a enchufarlo y montarlo: READY con una generación nueva. */
  reconnect(): void {
    this.state = 'READY';
    this.generation += 1;
  }
}

export interface Harness {
  readonly root: string;
  readonly dataRoot: string;
  readonly stagingDir: string;
  readonly gate: FakeGate;
  readonly db: Db;
  readonly config: PcloudConfig;
  /** Cola serie compartida por subidas y operaciones de este banco de pruebas. */
  readonly serial: SerialQueue;
  uploads(overrides?: Partial<UploadManagerOptions>): UploadManager;
  operations(overrides?: Partial<FsOperationsOptions>): FsOperations;
  dispose(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pcloud-vol-'));
  const dataRoot = path.join(root, 'data');
  const stagingDir = path.join(root, '.pcloud', 'staging');
  await mkdir(dataRoot);
  await mkdir(stagingDir, { recursive: true });
  const gate = new FakeGate(root);
  const db = await openDatabase(':memory:');
  const defaults = validateConfig({});
  // El mountpoint de pruebas es un directorio temporal del SO (en Windows no es una ruta POSIX).
  const config: PcloudConfig = { ...defaults, storage: { ...defaults.storage, mountpoint: root, minFreePercent: 0, minFreeBytes: 0 } };
  const serial = new SerialQueue();
  return {
    root, dataRoot, stagingDir, gate, db, config, serial,
    operations: (overrides = {}) =>
      new FsOperations({ gate, serial, minFreePercent: 0, minFreeBytes: 0, trashRetentionDays: 30, ...overrides }),
    uploads: (overrides = {}) =>
      new UploadManager({
        db, gate,
        chunkSize: 64 * 1024,
        maxChunkSize: 256 * 1024,
        checkpointBytes: 128 * 1024,
        ttlMs: 60 * 60 * 1000,
        minFreePercent: 0,
        minFreeBytes: 0,
        serial,
        ...overrides,
      }),
    dispose: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Crea un usuario directamente en la base y devuelve su id. */
export function insertUser(db: Db, username = 'ana', role: 'owner' | 'user' = 'owner', passwordHash = 'x'): number {
  const result = db
    .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, role, '2026-11-14T10:00:00.000Z');
  return Number(result.lastInsertRowid);
}

export async function* chunksOf(buffer: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size);
}
