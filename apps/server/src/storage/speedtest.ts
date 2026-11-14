/**
 * Test de velocidad del disco (Ajustes): mide lectura y escritura reales del HDD con fio en modo
 * directo (O_DIRECT), es decir, sin la caché de memoria del sistema, que daría cifras irreales.
 *
 *   1. Escritura secuencial de 256 MiB (bloques de 1 MiB) con fsync al final.
 *   2. Lectura secuencial del mismo archivo.
 *   3. Lectura aleatoria de 4 KiB durante 5 s (IOPS: lo que nota el explorador con muchas fotos).
 *
 * El archivo de prueba vive en `.pcloud/staging` del propio HDD y se borra siempre al terminar.
 */

import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type { DiskSpeedResponse } from '@pcloud/contracts';
import { AppError } from '../errors.ts';
import { Limiter, runTool } from '../media/media.ts';
import { assertSpaceFor, type SpacePolicy } from './space.ts';
import type { VolumeGate } from './uploads.ts';

const TEST_MIB = 256;
const limiter = new Limiter(1);

interface FioJob {
  read?: { bw_bytes?: number; iops?: number };
  write?: { bw_bytes?: number; iops?: number };
}

async function fio(binary: string, args: string[]): Promise<FioJob> {
  const result = await runTool(binary, [...args, '--output-format=json'], { timeoutMs: 180_000, maxOutput: 4 * 1024 * 1024 });
  if (result.code !== 0) throw new AppError('INTERNAL', `La prueba de velocidad falló: ${result.stderr.slice(0, 200)}`);
  const parsed = JSON.parse(result.stdout.toString()) as { jobs?: FioJob[] };
  const job = parsed.jobs?.[0];
  if (job === undefined) throw new AppError('INTERNAL', 'La prueba de velocidad no devolvió resultados');
  return job;
}

export async function measureDiskSpeed(gate: VolumeGate, fioBinary: string | null, space: SpacePolicy, clock: () => Date = () => new Date()): Promise<DiskSpeedResponse> {
  if (fioBinary === null) throw new AppError('UNSUPPORTED_MEDIA', 'Falta la herramienta fio en el servidor (pcloud-install-packages.sh)');
  if (limiter.active > 0) throw new AppError('CONFLICT', 'Ya hay una prueba de velocidad en curso', { retryable: true });
  return limiter.run(async () => {
    const lease = await gate.assertWritableVolume();
    await assertSpaceFor(lease.mountPoint, space, TEST_MIB * 2 * 1024 * 1024);
    const file = path.join(lease.internalDir, 'staging', `speedtest-${randomUUID()}.tmp`);
    const started = Date.now();
    const common = [`--filename=${file}`, '--direct=1', '--ioengine=psync', `--size=${TEST_MIB}M`, '--name=pcloud'];
    try {
      await gate.revalidate(lease);
      const write = await fio(fioBinary, [...common, '--rw=write', '--bs=1M', '--end_fsync=1']);
      await gate.revalidate(lease);
      const read = await fio(fioBinary, [...common, '--rw=read', '--bs=1M']);
      const random = await fio(fioBinary, [...common, '--rw=randread', '--bs=4k', '--runtime=5', '--time_based']);
      return {
        writeMBps: Math.round(((write.write?.bw_bytes ?? 0) / 1e6) * 10) / 10,
        readMBps: Math.round(((read.read?.bw_bytes ?? 0) / 1e6) * 10) / 10,
        randomReadIops: Math.round(random.read?.iops ?? 0),
        sizeMB: Math.round((TEST_MIB * 1024 * 1024) / 1e6),
        durationMs: Date.now() - started,
        testedAt: clock().toISOString(),
      };
    } finally {
      await unlink(file).catch(() => undefined);
    }
  });
}
