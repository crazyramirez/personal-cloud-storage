/**
 * Recursos del equipo para el panel: CPU, temperatura, memoria, red, disco del sistema y
 * alimentación (Raspberry Pi). Solo lectura de /proc y /sys (y `vcgencmd` cada 30 s si existe):
 * nada toca los discos de datos.
 *
 * Se muestrea cada 5 s y se guardan los últimos 15 min para las gráficas. Cada lectura es un
 * fichero pequeño del kernel: el coste es despreciable incluso en una Raspberry Pi.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import type { ResourcesResponse } from '@pcloud/contracts';

const execFileAsync = promisify(execFile);

const SAMPLE_MS = 5000;
const HISTORY = 180; // 15 min
const POWER_EVERY_MS = 30_000;

interface CpuTimes {
  idle: number;
  total: number;
}

/** Líneas `cpu` y `cpuN` de /proc/stat → tiempos acumulados (total e inactivo). */
export function parseProcStat(text: string): CpuTimes[] {
  const out: CpuTimes[] = [];
  for (const line of text.split('\n')) {
    if (!/^cpu\d*\s/.test(line)) continue;
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
    out.push({ idle: idle + iowait, total: user + nice + system + idle + iowait + irq + softirq + steal });
  }
  return out;
}

/** Porcentaje de uso entre dos lecturas (0-100). */
export function cpuPercent(before: CpuTimes, after: CpuTimes): number {
  const total = after.total - before.total;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, ((total - (after.idle - before.idle)) / total) * 100));
}

export function parseMeminfo(text: string): { total: number; available: number; swapTotal: number; swapFree: number } {
  const value = (key: string): number => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
    return match === null ? 0 : Number(match[1]) * 1024;
  };
  return { total: value('MemTotal'), available: value('MemAvailable'), swapTotal: value('SwapTotal'), swapFree: value('SwapFree') };
}

/** Bytes recibidos y enviados por todas las interfaces salvo loopback. */
export function parseNetDev(text: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (name === undefined || rest === undefined || name.trim() === 'lo') continue;
    const fields = rest.trim().split(/\s+/).map(Number);
    rx += fields[0] ?? 0;
    tx += fields[8] ?? 0;
  }
  return { rx, tx };
}

/**
 * `vcgencmd get_throttled` (bits de la documentación de Raspberry Pi): 0 subtensión, 1 frecuencia
 * limitada, 2 ralentizado, 3 límite térmico suave; +16 = lo mismo «desde el arranque».
 */
export function decodeThrottled(value: number): NonNullable<ResourcesResponse['power']> {
  const bit = (n: number): boolean => (value & (1 << n)) !== 0;
  return {
    undervoltageNow: bit(0),
    throttledNow: bit(1) || bit(2),
    heatLimitNow: bit(3),
    undervoltageSinceBoot: bit(16),
    throttledSinceBoot: bit(17) || bit(18),
    heatLimitSinceBoot: bit(19),
  };
}

function osCpuTimes(): CpuTimes[] {
  const cores = os.cpus().map(({ times }) => ({ idle: times.idle, total: times.user + times.nice + times.sys + times.idle + times.irq }));
  const all = cores.reduce((sum, core) => ({ idle: sum.idle + core.idle, total: sum.total + core.total }), { idle: 0, total: 0 });
  return [all, ...cores];
}

const readText = (file: string): Promise<string | null> => readFile(file, 'utf8').catch(() => null);

export class ResourceMonitor {
  #timer: ReturnType<typeof setInterval> | null = null;
  #lastCpu: CpuTimes[] | null = null;
  #lastNet: { rx: number; tx: number; at: number } | null = null;
  #cpu = 0;
  #cores: number[] = [];
  #rxBps = 0;
  #txBps = 0;
  #power: ResourcesResponse['power'] = null;
  #powerAt = 0;
  #static: { model: string | null; os: string | null } | null = null;
  readonly #history = { at: [] as number[], cpu: [] as number[], temp: [] as Array<number | null>, mem: [] as number[], rx: [] as number[], tx: [] as number[] };

  start(): void {
    void this.sample();
    this.#timer = setInterval(() => void this.sample(), SAMPLE_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async sample(): Promise<void> {
    try {
      const now = Date.now();
      const [stat, net] = await Promise.all([readText('/proc/stat'), readText('/proc/net/dev')]);
      // Sin /proc (desarrollo en Windows/macOS): los mismos tiempos desde os.cpus().
      const cpu = stat !== null ? parseProcStat(stat) : osCpuTimes();
      if (cpu.length > 0) {
        if (this.#lastCpu !== null && this.#lastCpu.length === cpu.length) {
          this.#cpu = cpuPercent(this.#lastCpu[0] as CpuTimes, cpu[0] as CpuTimes);
          this.#cores = cpu.slice(1).map((times, index) => cpuPercent(this.#lastCpu?.[index + 1] as CpuTimes, times));
        }
        this.#lastCpu = cpu;
      }
      if (net !== null) {
        const totals = parseNetDev(net);
        if (this.#lastNet !== null && now > this.#lastNet.at) {
          const seconds = (now - this.#lastNet.at) / 1000;
          this.#rxBps = Math.max(0, (totals.rx - this.#lastNet.rx) / seconds);
          this.#txBps = Math.max(0, (totals.tx - this.#lastNet.tx) / seconds);
        }
        this.#lastNet = { ...totals, at: now };
      }
      const memory = await this.#memory();
      const temp = await this.#temperature();
      if (now - this.#powerAt >= POWER_EVERY_MS) {
        this.#powerAt = now;
        this.#power = await this.#readPower();
      }
      const h = this.#history;
      h.at.push(now);
      h.cpu.push(Math.round(this.#cpu * 10) / 10);
      h.temp.push(temp === null ? null : Math.round(temp * 10) / 10);
      h.mem.push(memory.total === 0 ? 0 : Math.round(((memory.total - memory.available) / memory.total) * 1000) / 10);
      h.rx.push(Math.round(this.#rxBps));
      h.tx.push(Math.round(this.#txBps));
      if (h.at.length > HISTORY) for (const series of Object.values(h)) series.shift();
    } catch {
      // Un fallo puntual de lectura no debe tumbar nada: se reintenta en la siguiente muestra.
    }
  }

  async snapshot(): Promise<ResourcesResponse> {
    if (this.#static === null) {
      const model = (await readText('/proc/device-tree/model'))?.replace(/\0/g, '').trim() || os.cpus()[0]?.model || null;
      const release = await readText('/etc/os-release');
      const pretty = release === null ? null : /^PRETTY_NAME="?([^"\n]*)"?/m.exec(release)?.[1] ?? null;
      this.#static = { model, os: pretty };
    }
    const memory = await this.#memory();
    const root = await statfs('/').catch(() => null);
    const freq = Number(await readText('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq'));
    const maxFreq = Number(await readText('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq'));
    const app = process.memoryUsage();
    return {
      at: new Date().toISOString(),
      cpu: {
        percent: Math.round(this.#cpu * 10) / 10,
        cores: this.#cores.map((value) => Math.round(value)),
        load: os.loadavg().map((value) => Math.round(value * 100) / 100),
        mhz: Number.isFinite(freq) && freq > 0 ? Math.round(freq / 1000) : null,
        maxMhz: Number.isFinite(maxFreq) && maxFreq > 0 ? Math.round(maxFreq / 1000) : null,
      },
      temperature: await this.#temperature(),
      memory: {
        totalBytes: memory.total,
        usedBytes: memory.total - memory.available,
        swapTotalBytes: memory.swapTotal,
        swapUsedBytes: memory.swapTotal - memory.swapFree,
      },
      systemDisk: root === null ? null : { totalBytes: root.blocks * root.bsize, freeBytes: root.bavail * root.bsize },
      network: { rxBytesPerSecond: Math.round(this.#rxBps), txBytesPerSecond: Math.round(this.#txBps) },
      power: this.#power,
      host: { name: os.hostname(), model: this.#static.model, os: this.#static.os, kernel: os.release(), node: process.version },
      uptimeSeconds: Math.round(os.uptime()),
      app: { memoryBytes: app.rss, uptimeSeconds: Math.round(process.uptime()) },
      history: { ...this.#history, intervalSeconds: SAMPLE_MS / 1000 },
    };
  }

  async #memory(): Promise<ReturnType<typeof parseMeminfo>> {
    const text = await readText('/proc/meminfo');
    if (text !== null) return parseMeminfo(text);
    return { total: os.totalmem(), available: os.freemem(), swapTotal: 0, swapFree: 0 };
  }

  async #temperature(): Promise<number | null> {
    const raw = await readText('/sys/class/thermal/thermal_zone0/temp');
    const value = Number(raw);
    return raw === null || !Number.isFinite(value) ? null : value / 1000;
  }

  async #readPower(): Promise<ResourcesResponse['power']> {
    try {
      const { stdout } = await execFileAsync('vcgencmd', ['get_throttled'], { timeout: 3000 });
      const match = /throttled=0x([0-9a-f]+)/i.exec(stdout);
      if (match !== null) return decodeThrottled(Number.parseInt(match[1] as string, 16));
    } catch {
      // Sin vcgencmd (no es una Raspberry Pi o no hay acceso): se prueba el sensor del kernel.
    }
    let alarm: string | null = null;
    for (const dir of await readdir('/sys/class/hwmon').catch(() => [] as string[])) {
      if ((await readText(`/sys/class/hwmon/${dir}/name`))?.trim() === 'rpi_volt') alarm = await readText(`/sys/class/hwmon/${dir}/in0_lcrit_alarm`);
    }
    if (alarm === null) return null;
    const now = alarm.trim() === '1';
    return { undervoltageNow: now, throttledNow: false, heatLimitNow: false, undervoltageSinceBoot: now, throttledSinceBoot: false, heatLimitSinceBoot: false };
  }
}
