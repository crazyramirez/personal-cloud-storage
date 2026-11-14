/**
 * Subidas reanudables por offset confirmado (ADR-0010) con el protocolo de commit de ADR-0009.
 *
 *   crear    → fichero temporal `.pcloud/staging/<id>.part` en el MISMO HDD (nunca en la microSD).
 *   añadir   → bloques secuenciales en el offset que el servidor espera. Lo recibido solo se da por
 *              CONFIRMADO tras fsync (punto de control cada `checkpointBytes` y al llegar al final);
 *              ese offset confirmado es el que se guarda en SQLite.
 *   reanudar → tras un reinicio o un cambio de generación del volumen (desconexión, remontaje), la
 *              subida retrocede al último offset confirmado y descarta la cola sin confirmar.
 *   completar→ fsync → verificación de tamaño (y SHA-256 si el cliente lo dio) → revalidar el lease →
 *              rename al destino → fsync del directorio → COMPLETED. Nunca sobrescribe: si el nombre
 *              existe, se guarda como «nombre (2).ext».
 *
 * Toda mutación pasa por un lease de escritura del StorageGuardian.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, rename, truncate, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { UploadCompleteResponse, UploadInitRequest, UploadInitResponse } from '@pcloud/contracts';
import type { Db } from '../db/database.ts';
import { AppError, errnoOf } from '../errors.ts';
import { syncDirectory } from '../fs/durability.ts';
import { checkNewName, foldKey, uniqueName } from './names.ts';
import { formatClientPath, isReservedTopName, parseClientPath, resolveInside } from './paths.ts';
import { SerialQueue } from './serial.ts';
import { assertSpaceFor } from './space.ts';
import type { VolumeLease } from './storage-guardian.ts';

/** Lo que las subidas necesitan del StorageGuardian (permite tests sin hardware). */
export interface VolumeGate {
  assertWritableVolume(): Promise<VolumeLease>;
  assertReadableVolume(): Promise<VolumeLease>;
  revalidate(lease: VolumeLease): Promise<void>;
}

export interface UploadManagerOptions {
  readonly db: Db;
  readonly gate: VolumeGate;
  /** Tamaño de bloque recomendado al cliente. */
  readonly chunkSize: number;
  /** Máximo aceptado por petición. */
  readonly maxChunkSize: number;
  /** Bytes entre fsync (ADR-0009: nunca por bloque; un vaciado real cuesta ~60 ms). */
  readonly checkpointBytes: number;
  readonly ttlMs: number;
  readonly minFreePercent: number;
  readonly minFreeBytes: number;
  readonly clock?: () => Date;
  /** Cola compartida con las operaciones del explorador (elegir nombre libre + rename atómicos). */
  readonly serial?: SerialQueue;
}

type UploadState = 'receiving' | 'committing' | 'completed' | 'cancelled' | 'failed';

interface UploadRow {
  readonly id: string;
  readonly userId: number;
  readonly dirPath: string;
  readonly name: string;
  readonly size: number;
  readonly expectedSha256: string | null;
  readonly confirmedOffset: number;
  readonly state: UploadState;
  readonly finalPath: string | null;
}

/** Estado en memoria de una subida en curso. Se descarta al cambiar la generación del volumen. */
interface LiveUpload {
  offset: number;
  generation: number;
  sinceSync: number;
  busy: boolean;
}

export interface UploadStatus {
  readonly offset: number;
  readonly size: number;
  readonly state: UploadState;
}

export class UploadManager {
  readonly #o: UploadManagerOptions;
  readonly #clock: () => Date;
  readonly #live = new Map<string, LiveUpload>();
  readonly #serial: SerialQueue;

  constructor(options: UploadManagerOptions) {
    this.#o = options;
    this.#clock = options.clock ?? (() => new Date());
    this.#serial = options.serial ?? new SerialQueue();
  }

  #staging(lease: VolumeLease, id: string): string {
    return path.join(lease.internalDir, 'staging', `${id}.part`);
  }

  #row(userId: number, id: string): UploadRow {
    const row = this.#o.db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(id, userId);
    if (row === undefined) throw new AppError('NOT_FOUND', 'La subida no existe o ha caducado');
    return {
      id: String(row['id']),
      userId: Number(row['user_id']),
      dirPath: String(row['dir_path']),
      name: String(row['name']),
      size: Number(row['size']),
      expectedSha256: row['expected_sha256'] === null ? null : String(row['expected_sha256']),
      confirmedOffset: Number(row['confirmed_offset']),
      state: String(row['state']) as UploadState,
      finalPath: row['final_path'] === null ? null : String(row['final_path']),
    };
  }

  #update(id: string, fields: Record<string, string | number | null>): void {
    const names = Object.keys(fields);
    const sql = `UPDATE uploads SET ${names.map((name) => `${name} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
    this.#o.db.prepare(sql).run(...names.map((name) => fields[name] ?? null), this.#clock().toISOString(), id);
  }

  /** Falla con 507 si escribir `bytes` dejaría el volumen por debajo de la reserva (spec §7.3). */
  #assertSpace(lease: VolumeLease, bytes: number): Promise<void> {
    return assertSpaceFor(lease.mountPoint, this.#o, bytes);
  }

  /** Offset vigente para este lease: el de memoria si la generación coincide; si no, el confirmado. */
  #liveFor(row: UploadRow, lease: VolumeLease): LiveUpload | null {
    const live = this.#live.get(row.id);
    return live !== undefined && live.generation === lease.generation ? live : null;
  }

  async create(userId: number, request: UploadInitRequest): Promise<UploadInitResponse> {
    const name = checkNewName(request.name);
    const segments = parseClientPath(request.path);
    if (segments.length === 0 && isReservedTopName(name)) throw new AppError('INVALID_NAME', 'Nombre reservado del sistema');
    const lease = await this.#o.gate.assertWritableVolume();
    await resolveInside(lease.dataRoot, segments, 'dir');
    await this.#assertSpace(lease, request.size);

    const id = randomUUID();
    await this.#o.gate.revalidate(lease);
    const handle = await open(this.#staging(lease, id), 'wx', 0o600);
    await handle.close();

    const now = this.#clock();
    this.#o.db
      .prepare(
        `INSERT INTO uploads (id, user_id, dir_path, name, size, expected_sha256, confirmed_offset, state, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'receiving', ?, ?, ?)`,
      )
      .run(
        id, userId, formatClientPath(segments), name, request.size, request.sha256 ?? null,
        now.toISOString(), now.toISOString(), new Date(now.getTime() + this.#o.ttlMs).toISOString(),
      );
    this.#live.set(id, { offset: 0, generation: lease.generation, sinceSync: 0, busy: false });
    return { id, offset: 0, chunkSize: this.#o.chunkSize, maxChunkSize: this.#o.maxChunkSize };
  }

  async status(userId: number, id: string): Promise<UploadStatus> {
    const row = this.#row(userId, id);
    if (row.state !== 'receiving') return { offset: row.confirmedOffset, size: row.size, state: row.state };
    const lease = await this.#o.gate.assertReadableVolume();
    const live = this.#liveFor(row, lease);
    return { offset: live?.offset ?? row.confirmedOffset, size: row.size, state: row.state };
  }

  /** Añade un bloque en `offset`. Devuelve el nuevo offset. */
  async append(userId: number, id: string, offset: number, body: AsyncIterable<Uint8Array>): Promise<number> {
    const row = this.#row(userId, id);
    if (row.state !== 'receiving') throw new AppError('CONFLICT', 'La subida ya no admite datos');
    const lease = await this.#o.gate.assertWritableVolume();
    const staging = this.#staging(lease, id);

    let live = this.#liveFor(row, lease);
    if (live === null) {
      // Reinicio o cambio de generación: lo no confirmado con fsync no cuenta. Se descarta.
      // La plaza se ocupa antes de esperar al truncado: un segundo bloque simultáneo ve «busy».
      live = { offset: row.confirmedOffset, generation: lease.generation, sinceSync: 0, busy: true };
      this.#live.set(id, live);
      try {
        await truncate(staging, row.confirmedOffset);
      } catch (error) {
        this.#live.delete(id);
        if (errnoOf(error) === 'ENOENT') {
          this.#update(id, { state: 'failed' });
          throw new AppError('NOT_FOUND', 'El fichero temporal de la subida ya no existe: hay que empezar de nuevo');
        }
        throw error;
      }
      live.busy = false;
    }
    if (live.busy) throw new AppError('CONFLICT', 'Ya hay un bloque en curso para esta subida', { retryable: true });
    if (offset !== live.offset) {
      throw new AppError('OFFSET_MISMATCH', 'El offset no coincide con el del servidor', {
        retryable: true,
        details: { offset: live.offset },
      });
    }

    const limit = Math.min(row.size - live.offset, this.#o.maxChunkSize);
    live.busy = true;
    let handle;
    try {
      await this.#assertSpace(lease, 0);
      handle = await open(staging, 'r+');
      let written = 0;
      for await (const chunk of body) {
        if (written + chunk.length > limit) {
          throw new AppError('PAYLOAD_TOO_LARGE', 'El bloque supera el tamaño permitido o el tamaño declarado del archivo');
        }
        await handle.write(chunk, 0, chunk.length, live.offset + written);
        written += chunk.length;
      }
      // Solo aquí se cuenta el bloque: si la conexión se cortó a medias, el cliente lo reenvía entero.
      live.offset += written;
      live.sinceSync += written;
      if (live.sinceSync >= this.#o.checkpointBytes || live.offset === row.size) {
        await handle.sync();
        await this.#o.gate.revalidate(lease);
        this.#update(id, {
          confirmed_offset: live.offset,
          expires_at: new Date(this.#clock().getTime() + this.#o.ttlMs).toISOString(),
        });
        live.sinceSync = 0;
      }
      return live.offset;
    } finally {
      live.busy = false;
      await handle?.close().catch(() => undefined);
    }
  }

  /** Completa la subida. Idempotente: repetir la llamada devuelve el mismo resultado. */
  complete(userId: number, id: string): Promise<UploadCompleteResponse> {
    // Los commits se serializan (con el explorador): nadie puede elegir el mismo destino a la vez.
    return this.#serial.run(() => this.#complete(userId, id));
  }

  async #complete(userId: number, id: string): Promise<UploadCompleteResponse> {
    const row = this.#row(userId, id);
    if (row.state === 'completed' && row.finalPath !== null) {
      return { path: row.finalPath, name: row.finalPath.slice(row.finalPath.lastIndexOf('/') + 1), size: row.size };
    }
    if (row.state !== 'receiving') throw new AppError('CONFLICT', `La subida está en estado ${row.state}`);

    const lease = await this.#o.gate.assertWritableVolume();
    const staging = this.#staging(lease, id);
    const offset = this.#liveFor(row, lease)?.offset ?? row.confirmedOffset;
    if (offset !== row.size) {
      throw new AppError('OFFSET_MISMATCH', 'Faltan datos por recibir', { retryable: true, details: { offset } });
    }

    const handle = await open(staging, 'r+');
    try {
      await handle.sync();
      const stats = await handle.stat();
      if (stats.size !== row.size) {
        throw new AppError('OFFSET_MISMATCH', 'El fichero recibido no tiene el tamaño declarado', {
          retryable: true,
          details: { offset: Math.min(stats.size, row.confirmedOffset) },
        });
      }
    } finally {
      await handle.close();
    }
    this.#update(id, { confirmed_offset: row.size });

    if (row.expectedSha256 !== null) {
      const actual = await sha256File(staging);
      if (actual !== row.expectedSha256) {
        this.#update(id, { state: 'failed' });
        this.#live.delete(id);
        throw new AppError('CHECKSUM_MISMATCH', 'El contenido recibido no coincide con el SHA-256 declarado');
      }
    }

    const segments = parseClientPath(row.dirPath);
    const dir = await resolveInside(lease.dataRoot, segments, 'dir');
    const taken = new Set((await readdir(dir.abs)).map(foldKey));
    const finalName = uniqueName(row.name, taken);
    const finalAbs = path.join(dir.abs, finalName);
    const finalPath = formatClientPath([...segments, finalName]);

    this.#update(id, { state: 'committing', final_path: finalPath });
    try {
      await this.#o.gate.revalidate(lease); // justo antes de confirmar (spec §3.4.5)
      await rename(staging, finalAbs);
    } catch (error) {
      // El temporal sigue intacto: la subida vuelve a ser reintentable en lugar de quedar atascada.
      this.#update(id, { state: 'receiving', final_path: null });
      throw error;
    }
    await syncDirectory(dir.abs); // sin esto el rename puede perderse (F0, ADR-0009)
    await syncDirectory(path.dirname(staging));
    this.#update(id, { state: 'completed' });
    this.#live.delete(id);
    return { path: finalPath, name: finalName, size: row.size };
  }

  cancel(userId: number, id: string): Promise<void> {
    return this.#serial.run(async () => {
      const row = this.#row(userId, id);
      if (row.state !== 'receiving') return;
      if (this.#live.get(id)?.busy === true) throw new AppError('CONFLICT', 'Hay un bloque en curso: vuelve a intentarlo', { retryable: true });
      const lease = await this.#o.gate.assertWritableVolume();
      if (!this.#transition(id, 'receiving', 'cancelled')) return;
      this.#live.delete(id);
      await unlink(this.#staging(lease, id)).catch((error: unknown) => {
        if (errnoOf(error) !== 'ENOENT') throw error;
      });
    });
  }

  /** Cambia de estado solo si sigue en `from` (nunca pisa un estado que otro ya cambió). */
  #transition(id: string, from: UploadState, to: UploadState): boolean {
    const result = this.#o.db
      .prepare('UPDATE uploads SET state = ?, updated_at = ? WHERE id = ? AND state = ?')
      .run(to, this.#clock().toISOString(), id, from);
    return Number(result.changes) === 1;
  }

  /**
   * Reconciliación tras un reinicio (spec §7.2.9): resuelve las subidas que quedaron en COMMITTING.
   * Nunca borra: si el destino existe, COMPLETED; si no y el temporal está completo, rehace el rename.
   */
  recover(): Promise<void> {
    // En la cola de mutaciones: ni un commit en curso ni un movimiento pueden cruzarse con ella.
    return this.#serial.run(() => this.#recover());
  }

  async #recover(): Promise<void> {
    const rows = this.#o.db.prepare("SELECT id, user_id FROM uploads WHERE state = 'committing'").all();
    if (rows.length === 0) return;
    const lease = await this.#o.gate.assertWritableVolume();
    for (const pending of rows) {
      const row = this.#row(Number(pending['user_id']), String(pending['id']));
      if (row.state !== 'committing') continue; // otro proceso ya la resolvió
      try {
        if (row.finalPath === null) throw new Error('sin destino registrado');
        const segments = parseClientPath(row.finalPath);
        const finalAbs = path.join(lease.dataRoot, ...segments);
        const staging = this.#staging(lease, row.id);
        const finalSize = await sizeOrNull(finalAbs);
        const stagingSize = await sizeOrNull(staging);
        if (finalSize === row.size && stagingSize === null) {
          this.#update(row.id, { state: 'completed' }); // el rename llegó al disco
        } else if (finalSize === null && stagingSize === row.size) {
          await this.#o.gate.revalidate(lease);
          if ((await sizeOrNull(finalAbs)) !== null || (await lstat(finalAbs).then(() => true, () => false))) {
            throw new Error('el destino apareció mientras se recuperaba');
          }
          await rename(staging, finalAbs); // el rename se perdió: se rehace
          await syncDirectory(path.dirname(finalAbs));
          this.#update(row.id, { state: 'completed' });
        } else {
          this.#update(row.id, { state: 'failed' }); // ambiguo: no se toca ningún fichero
        }
      } catch {
        this.#update(row.id, { state: 'failed' });
      }
    }
  }

  /** Retira los temporales de subidas caducadas (spec §12.2). Solo con el volumen escribible. */
  cleanupExpired(): Promise<number> {
    return this.#serial.run(async () => {
      const now = this.#clock().toISOString();
      const rows = this.#o.db.prepare("SELECT id FROM uploads WHERE state = 'receiving' AND expires_at <= ?").all(now);
      if (rows.length === 0) return 0;
      const lease = await this.#o.gate.assertWritableVolume();
      let removed = 0;
      for (const row of rows) {
        const id = String(row['id']);
        if (this.#live.get(id)?.busy === true) continue;
        if (!this.#transition(id, 'receiving', 'cancelled')) continue;
        this.#live.delete(id);
        await unlink(this.#staging(lease, id)).catch((error: unknown) => {
          if (errnoOf(error) !== 'ENOENT') throw error;
        });
        removed += 1;
      }
      return removed;
    });
  }
}

async function sizeOrNull(target: string): Promise<number | null> {
  try {
    const stats = await lstat(target);
    return stats.isFile() ? stats.size : null;
  } catch (error) {
    if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') return null;
    throw error;
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export type { UploadRow };
