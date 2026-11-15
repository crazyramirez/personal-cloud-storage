/**
 * Cliente del agente root de reinicio y apagado (deploy/linux/power/pcloud-power-agent.sh,
 * ADR-0020). pcloud.service no tiene privilegios: deja «reboot» o «poweroff» en el buzón y el
 * agente lo programa 5 s después, para que la respuesta HTTP llegue antes del corte.
 */

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type PowerAction = 'reboot' | 'poweroff';

export interface PowerAgent {
  ready(): Promise<boolean>;
  request(action: PowerAction): Promise<{ ok: boolean; code: string }>;
}

export class FilePowerAgent implements PowerAgent {
  private readonly inbox: string;
  private readonly outbox: string;
  private readonly timeoutMs: number;

  constructor(inbox = '/var/lib/pcloud/power-agent/inbox', outbox = '/run/pcloud-power-agent', timeoutMs = 20_000) {
    this.inbox = inbox;
    this.outbox = outbox;
    this.timeoutMs = timeoutMs;
  }

  async ready(): Promise<boolean> {
    return access(this.inbox, constants.W_OK).then(() => true, () => false);
  }

  async request(action: PowerAction): Promise<{ ok: boolean; code: string }> {
    if (!(await this.ready())) return { ok: false, code: 'AGENT_UNAVAILABLE' };
    const id = randomBytes(10).toString('hex');
    const temp = path.join(this.inbox, `.${id}.tmp`);
    await writeFile(temp, `${action}\n`, { mode: 0o600 });
    await rename(temp, path.join(this.inbox, `${id}.req`));
    const answer = path.join(this.outbox, `${id}.json`);
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const raw = await readFile(answer, 'utf8').catch(() => null);
      if (raw === null) continue;
      try {
        const parsed = JSON.parse(raw) as { id?: unknown; ok?: unknown; code?: unknown };
        if (parsed.id === id && typeof parsed.ok === 'boolean' && typeof parsed.code === 'string') return { ok: parsed.ok, code: parsed.code };
      } catch {
        // A medio escribir: se reintenta.
      }
    }
    await unlink(path.join(this.inbox, `${id}.req`)).catch(() => undefined);
    return { ok: false, code: 'AGENT_UNAVAILABLE' };
  }
}
