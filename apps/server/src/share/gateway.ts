/**
 * Puerta de invitados (ADR-0018): decide si Tailscale Funnel tiene que estar publicado.
 *
 * Regla única: Funnel está encendido SOLO mientras exista al menos un enlace activo. Sin enlaces
 * (o al caducar o revocar el último), se apaga y la Pi deja de ser alcanzable desde Internet.
 *
 * pcloud.service no tiene privilegios: no puede ejecutar `tailscale funnel`. Deja una petición
 * de una palabra («on» u «off») en el buzón del agente root (deploy/linux/share/
 * pcloud-share-agent.sh), que solo sabe publicar el socket de la puerta de invitados en :8443.
 */

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GatewayState, GatewayView } from '@pcloud/contracts';

/**
 * La puerta de invitados escucha en un socket Unix, no en un puerto: no es alcanzable por TCP ni
 * siquiera desde la propia Pi. Solo tailscaled (root) conecta, cuando Funnel está publicado.
 */
export const GUEST_SOCKET = '/var/lib/pcloud/share-agent/guest.sock';
export const FUNNEL_PORT = 8443;

export interface AgentReply {
  readonly ok: boolean;
  readonly code: string;
  readonly url?: string | undefined;
  readonly enableUrl?: string | undefined;
}

export interface GatewayAgent {
  ready(): Promise<boolean>;
  request(action: 'on' | 'off'): Promise<AgentReply>;
}

const PUBLIC_URL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net:8443$/;
const ENABLE_URL = /^https:\/\/login\.tailscale\.com\/f\/[a-z]+\?node=[A-Za-z0-9]+$/;

export class FileGatewayAgent implements GatewayAgent {
  private readonly inbox: string;
  private readonly outbox: string;
  private readonly timeoutMs: number;

  constructor(inbox = '/var/lib/pcloud/share-agent/inbox', outbox = '/run/pcloud-share-agent', timeoutMs = 60_000) {
    this.inbox = inbox;
    this.outbox = outbox;
    this.timeoutMs = timeoutMs;
  }

  async ready(): Promise<boolean> {
    return access(this.inbox, constants.W_OK).then(() => true, () => false);
  }

  async request(action: 'on' | 'off'): Promise<AgentReply> {
    if (!(await this.ready())) return { ok: false, code: 'AGENT_UNAVAILABLE' };
    const id = randomBytes(10).toString('hex');
    const temp = path.join(this.inbox, `.${id}.tmp`);
    await writeFile(temp, `${action}\n`, { mode: 0o600 });
    await rename(temp, path.join(this.inbox, `${id}.req`));
    const answer = path.join(this.outbox, `${id}.json`);
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const raw = await readFile(answer, 'utf8').catch(() => null);
      if (raw === null) continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed['id'] !== id || typeof parsed['ok'] !== 'boolean' || typeof parsed['code'] !== 'string') continue;
        const url = typeof parsed['url'] === 'string' && PUBLIC_URL.test(parsed['url']) ? parsed['url'] : undefined;
        const enableUrl = typeof parsed['enableUrl'] === 'string' && ENABLE_URL.test(parsed['enableUrl']) ? parsed['enableUrl'] : undefined;
        return { ok: parsed['ok'], code: parsed['code'], url, enableUrl };
      } catch {
        // A medio escribir: se reintenta.
      }
    }
    await unlink(path.join(this.inbox, `${id}.req`)).catch(() => undefined);
    return { ok: false, code: 'AGENT_UNAVAILABLE' };
  }
}

/** Código del agente → estado que ve la web. */
function stateFor(reply: AgentReply, wanted: boolean): GatewayState {
  if (reply.ok) return wanted ? 'on' : 'off';
  switch (reply.code) {
    case 'FUNNEL_NOT_ALLOWED':
      return 'needs_funnel';
    case 'HTTPS_DISABLED':
      return 'needs_https';
    case 'NO_TAILSCALE':
    case 'NOT_LOGGED_IN':
      return 'no_tailscale';
    case 'AGENT_UNAVAILABLE':
      return 'unavailable';
    default:
      return 'error';
  }
}

export interface GatewayLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

const RETRY_MS = 5 * 60 * 1000;

export class ShareGateway {
  readonly #agent: GatewayAgent;
  readonly #activeCount: () => number;
  readonly #log: GatewayLogger;
  readonly #clock: () => Date;
  #view: GatewayView = { state: 'off', url: null, enableUrl: null, checkedAt: null };
  /** Último estado aplicado con éxito (null = desconocido: hay que aplicar). */
  #applied: boolean | null = null;
  #failedAt = 0;
  #lastWanted: boolean | null = null;
  #running: Promise<void> | null = null;
  #again = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: { agent: GatewayAgent; activeCount: () => number; log: GatewayLogger; clock?: () => Date }) {
    this.#agent = options.agent;
    this.#activeCount = options.activeCount;
    this.#log = options.log;
    this.#clock = options.clock ?? (() => new Date());
  }

  get view(): GatewayView {
    return this.#view;
  }

  /** Comprueba cada minuto (caducidades) y aplica al arrancar. */
  start(intervalMs = 60_000): void {
    void this.reconcile();
    this.#timer = setInterval(() => void this.reconcile(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Lleva Funnel al estado que toca. Las llamadas concurrentes se agrupan en una más. */
  reconcile(force = false): Promise<void> {
    if (this.#running !== null) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#apply(force).finally(() => {
      this.#running = null;
      if (this.#again) {
        this.#again = false;
        void this.reconcile();
      }
    });
    return this.#running;
  }

  async #apply(force: boolean): Promise<void> {
    const wanted = this.#activeCount() > 0;
    const changed = wanted !== this.#lastWanted;
    this.#lastWanted = wanted;
    if (!force && !changed) {
      if (this.#failedAt === 0 && this.#applied === wanted) return; // ya está como toca
      if (this.#failedAt > 0 && Date.now() - this.#failedAt < RETRY_MS) return; // espera antes de reintentar
    }
    if (wanted && this.#view.state === 'off') this.#view = { ...this.#view, state: 'starting' };
    const reply = await this.#agent.request(wanted ? 'on' : 'off').catch((): AgentReply => ({ ok: false, code: 'AGENT_UNAVAILABLE' }));
    const state = stateFor(reply, wanted);
    this.#view = {
      state,
      url: reply.ok && wanted ? (reply.url ?? null) : null,
      enableUrl: state === 'needs_funnel' ? (reply.enableUrl ?? null) : null,
      checkedAt: this.#clock().toISOString(),
    };
    if (reply.ok) {
      this.#applied = wanted;
      this.#failedAt = 0;
      this.#log.info({ funnel: wanted ? 'on' : 'off' }, 'puerta de invitados');
    } else {
      this.#failedAt = Date.now();
      // Sin agente y sin enlaces no hay nada publicado: no es un fallo que mostrar.
      if (!wanted && reply.code === 'AGENT_UNAVAILABLE') this.#view = { ...this.#view, state: 'off' };
      this.#log.warn({ code: reply.code, wanted }, 'no se pudo cambiar la puerta de invitados');
    }
  }
}
