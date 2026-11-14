/**
 * Cliente del agente root de la copia (deploy/linux/backup/pcloud-backup-agent.sh, ADR-0017).
 *
 * pcloud.service no puede montar discos: deja una petición de una línea en el buzón y espera la
 * respuesta que escribe el agente. El agente solo entiende «mount <UUID>» y «unmount <UUID>».
 */

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type AgentCode =
  | 'MOUNTED'
  | 'UNMOUNTED'
  | 'NOT_MOUNTED'
  | 'NOT_FOUND'
  | 'UNSUPPORTED_FS'
  | 'MOUNT_FAILED'
  | 'READ_ONLY'
  | 'BUSY'
  | 'BUSY_ELSEWHERE'
  | 'OTHER_DISK'
  | 'REFUSED_DATA_DISK'
  | 'REFUSED_SYSTEM_DISK'
  | 'REFUSED_DEVICE'
  | 'NO_MOUNTPOINT'
  | 'INVALID_REQUEST'
  | 'AGENT_UNAVAILABLE';

export interface AgentResult {
  readonly ok: boolean;
  readonly code: AgentCode;
}

export interface MountAgent {
  /** El agente está instalado (existe su buzón). */
  ready(): Promise<boolean>;
  request(action: 'mount' | 'unmount', uuid: string): Promise<AgentResult>;
}

const UUID = /^([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}|[0-9A-Fa-f]{16})$/;

export class FileMountAgent implements MountAgent {
  private readonly inbox: string;
  private readonly outbox: string;
  private readonly timeoutMs: number;

  constructor(inbox = '/var/lib/pcloud/backup-agent/inbox', outbox = '/run/pcloud-backup-agent', timeoutMs = 150_000) {
    this.inbox = inbox;
    this.outbox = outbox;
    this.timeoutMs = timeoutMs;
  }

  async ready(): Promise<boolean> {
    return access(this.inbox, constants.W_OK).then(() => true, () => false);
  }

  async request(action: 'mount' | 'unmount', uuid: string): Promise<AgentResult> {
    if (!UUID.test(uuid)) return { ok: false, code: 'INVALID_REQUEST' };
    if (!(await this.ready())) return { ok: false, code: 'AGENT_UNAVAILABLE' };
    const id = randomBytes(10).toString('hex');
    const temp = path.join(this.inbox, `.${id}.tmp`);
    await writeFile(temp, `${action} ${uuid}\n`, { mode: 0o600 });
    await rename(temp, path.join(this.inbox, `${id}.req`));
    const answer = path.join(this.outbox, `${id}.json`);
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const raw = await readFile(answer, 'utf8').catch(() => null);
      if (raw === null) continue;
      try {
        const parsed = JSON.parse(raw) as { id?: unknown; ok?: unknown; code?: unknown };
        if (parsed.id === id && typeof parsed.ok === 'boolean' && typeof parsed.code === 'string') {
          return { ok: parsed.ok, code: parsed.code as AgentCode };
        }
      } catch {
        // Respuesta a medio escribir: el agente la escribe con rename, pero por si acaso se reintenta.
      }
    }
    // Sin respuesta: se retira la petición si sigue ahí para que no se ejecute tarde.
    await unlink(path.join(this.inbox, `${id}.req`)).catch(() => undefined);
    return { ok: false, code: 'AGENT_UNAVAILABLE' };
  }
}
