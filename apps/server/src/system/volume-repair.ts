/**
 * Cliente de la reparación automática del disco de datos (ADR-0032).
 *
 * - `request()`: cuando el StorageGuardian ve el disco en solo lectura (MOUNT_READ_ONLY), deja un
 *   aviso vacío en el buzón del agente root (deploy/linux/volume/pcloud-volume-agent.sh). El agente
 *   comprueba por su cuenta si hace falta; el contenido del aviso no se lee.
 * - `status()`: lee el estado que dejan el agente y pcloud-volume-repair.sh en /run (solo de este
 *   arranque) para que la web diga «Reparando el disco…» en vez de «Disco no disponible».
 */

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VOLUME_REPAIR_PHASES, VOLUME_REPAIR_RESULTS, VOLUME_REPAIR_STEPS, type VolumeRepairStatus } from '@pcloud/contracts';

export interface VolumeRepairAgent {
  /** Avisa al agente. `false` si no está instalado. */
  request(): Promise<boolean>;
  status(): Promise<VolumeRepairStatus | null>;
}

/** Una comprobación que lleva más que esto en marcha se da por interrumpida (el agente corta a las 6 h). */
const STALE_MS = 7 * 60 * 60 * 1000;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Valida el JSON del agente; cualquier cosa inesperada se ignora (`null`). */
export function parseRepairStatus(raw: string, now: Date): VolumeRepairStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const phase = VOLUME_REPAIR_PHASES.find((p) => p === v.phase);
  const trigger = v.trigger === 'dirty' || v.trigger === 'readonly' ? v.trigger : undefined;
  const result = v.result === null ? null : VOLUME_REPAIR_RESULTS.find((r) => r === v.result);
  const startedAt = typeof v.startedAt === 'string' && ISO.test(v.startedAt) ? v.startedAt : undefined;
  const finishedAt = v.finishedAt === null ? null : typeof v.finishedAt === 'string' && ISO.test(v.finishedAt) ? v.finishedAt : undefined;
  if (phase === undefined || trigger === undefined || result === undefined || startedAt === undefined || finishedAt === undefined) return null;
  // Detalle del progreso: opcional (versiones anteriores del agente no lo escriben).
  const step = VOLUME_REPAIR_STEPS.find((s) => s === v.step) ?? null;
  const stepStartedAt = typeof v.stepStartedAt === 'string' && ISO.test(v.stepStartedAt) ? v.stepStartedAt : null;
  const count = (x: unknown): number | null => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 1e9 ? x : null);
  const detail = { step, stepStartedAt, estimateSeconds: count(v.estimateSeconds), fixed: count(v.fixed) };
  // Si el proceso murió a mitad (p. ej. lo mató systemd), no se queda «reparando» para siempre.
  if ((phase === 'pending' || phase === 'running') && now.getTime() - Date.parse(startedAt) > STALE_MS) {
    return { phase: 'failed', trigger, result: 'io_error', startedAt, finishedAt: null, ...detail, step: null };
  }
  return { phase, trigger, result, startedAt, finishedAt, ...detail };
}

export class FileVolumeRepairAgent implements VolumeRepairAgent {
  private readonly inbox: string;
  private readonly statusFile: string;
  private readonly clock: () => Date;

  constructor(inbox = '/var/lib/pcloud/volume-agent/inbox', statusFile = '/run/pcloud-volume-repair/status.json', clock: () => Date = () => new Date()) {
    this.inbox = inbox;
    this.statusFile = statusFile;
    this.clock = clock;
  }

  async request(): Promise<boolean> {
    if (!(await access(this.inbox, constants.W_OK).then(() => true, () => false))) return false;
    const id = randomBytes(10).toString('hex');
    const temp = path.join(this.inbox, `.${id}.tmp`);
    await writeFile(temp, '', { mode: 0o600 });
    await rename(temp, path.join(this.inbox, `${id}.req`));
    return true;
  }

  async status(): Promise<VolumeRepairStatus | null> {
    const raw = await readFile(this.statusFile, 'utf8').catch(() => null);
    return raw === null ? null : parseRepairStatus(raw, this.clock());
  }
}
