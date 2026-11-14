/**
 * Configuración de /etc/pcloud/config.yaml (spec §13), validada de forma estricta:
 *  - claves desconocidas = error (evita erratas silenciosas como `retention_day`);
 *  - se eliminan las opciones que solo permitirían estados inseguros (ADR-0007);
 *  - los valores por defecto son los iniciales de la spec, para PROBAR y AJUSTAR.
 */

import { readFile } from 'node:fs/promises';
import { posix as path } from 'node:path';
import { isIP } from 'node:net';
import { parse as parseYaml } from 'yaml';
import { INTERNAL_DIR_NAME, isFsUuid, type ConfiguredFsType } from '../storage/storage-guardian.ts';
import { isVolumeMarkerId } from '../storage/volume-marker.ts';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface PcloudConfig {
  readonly server: { readonly host: string; readonly port: number; readonly logLevel: LogLevel };
  readonly paths: { readonly stateDir: string };
  readonly storage: {
    readonly mountpoint: string;
    readonly rootRelative: string;
    readonly expectedFsUuid: string | null;
    readonly volumeMarker: string | null;
    readonly fsType: ConfiguredFsType;
    readonly minFreePercent: number;
    readonly minFreeBytes: number;
    readonly healthCheckIntervalSeconds: number;
    readonly versioningEnabled: boolean;
  };
  readonly transfers: {
    readonly maxConcurrentUploads: number;
    readonly maxConcurrentDownloads: number;
    readonly chunkSizeMib: number;
    readonly stagingTtlHours: number;
  };
  readonly indexer: {
    readonly maxParallelFileStats: number;
    readonly scanIntervalMinutes: number;
    readonly hashOnlyWhenNeeded: boolean;
  };
  readonly trash: { readonly enabled: boolean; readonly retentionDays: number };
  readonly security: { readonly lanOnlyDefault: boolean; readonly remoteAccessEnabled: boolean };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly problems: readonly string[];

  constructor(source: string, problems: readonly string[]) {
    super(`Configuración inválida (${source}):\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

/** Claves de la spec retiradas a propósito: el comportamiento es fijo por diseño. */
const REMOVED_KEYS: Readonly<Record<string, string>> = {
  'storage.on_missing_volume':
    'eliminada: sin volumen válido se rechazan SIEMPRE las mutaciones (503 STORAGE_UNAVAILABLE); no es configurable',
  'security.require_auth': 'eliminada: la autenticación es obligatoria siempre; no es configurable',
};

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Reader {
  readonly problems: string[] = [];

  section(root: Obj, key: string, allowed: readonly string[]): Obj {
    const value = root[key];
    if (value === undefined || value === null) return {};
    if (!isObj(value)) {
      this.problems.push(`${key}: debe ser un objeto`);
      return {};
    }
    for (const name of Object.keys(value)) {
      const full = `${key}.${name}`;
      const removed = REMOVED_KEYS[full];
      if (removed !== undefined) this.problems.push(`${full}: ${removed}`);
      else if (!allowed.includes(name)) this.problems.push(`${full}: clave desconocida`);
    }
    return value;
  }

  string(obj: Obj, key: string, where: string, fallback: string, check?: (v: string) => string | null): string {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value === '') {
      this.problems.push(`${where}.${key}: debe ser un texto no vacío`);
      return fallback;
    }
    const error = check?.(value) ?? null;
    if (error !== null) this.problems.push(`${where}.${key}: ${error}`);
    return value;
  }

  nullableString(obj: Obj, key: string, where: string, check: (v: string) => string | null): string | null {
    const value = obj[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
      this.problems.push(`${where}.${key}: debe ser texto o null`);
      return null;
    }
    const error = check(value);
    if (error !== null) {
      this.problems.push(`${where}.${key}: ${error}`);
      return null;
    }
    return value;
  }

  oneOf<T extends string>(obj: Obj, key: string, where: string, options: readonly T[], fallback: T, hint = ''): T {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T;
    this.problems.push(`${where}.${key}: debe ser uno de ${options.join(' | ')}${hint}`);
    return fallback;
  }

  number(obj: Obj, key: string, where: string, fallback: number, min: number, max: number, integer = true): number {
    const value = obj[key];
    if (value === undefined) return fallback;
    const valid =
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (!integer || Number.isSafeInteger(value)) &&
      value >= min &&
      value <= max;
    if (!valid) {
      this.problems.push(`${where}.${key}: debe ser un ${integer ? 'entero' : 'número'} entre ${min} y ${max}`);
      return fallback;
    }
    return value;
  }

  bool(obj: Obj, key: string, where: string, fallback: boolean): boolean {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      this.problems.push(`${where}.${key}: debe ser true o false`);
      return fallback;
    }
    return value;
  }
}

function checkAbsolute(value: string): string | null {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value === '/' || value.endsWith('/')) {
    return 'debe ser una ruta absoluta canónica distinta de "/" (sin barra final, sin "..")';
  }
  return null;
}

function checkRootRelative(value: string): string | null {
  const normalized = path.normalize(value);
  if (
    path.isAbsolute(value) || normalized !== value || value.endsWith('/') ||
    normalized === '..' || normalized.startsWith('../')
  ) {
    return 'debe ser relativa al volumen, normalizada y sin ".."';
  }
  if (normalized.split('/')[0] === INTERNAL_DIR_NAME) return `no puede estar dentro de ${INTERNAL_DIR_NAME}/`;
  return null;
}

function checkHost(value: string): string | null {
  return isIP(value) === 0 ? 'debe ser una dirección IP literal (recomendado 127.0.0.1 detrás del proxy TLS)' : null;
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export function validateConfig(raw: unknown, source = '<config>'): PcloudConfig {
  const r = new Reader();
  if (raw !== undefined && raw !== null && !isObj(raw)) throw new ConfigError(source, ['la raíz debe ser un objeto']);
  const root: Obj = isObj(raw) ? raw : {};
  const sections = ['server', 'paths', 'storage', 'transfers', 'indexer', 'trash', 'security'];
  for (const key of Object.keys(root)) if (!sections.includes(key)) r.problems.push(`${key}: sección desconocida`);

  const server = r.section(root, 'server', ['host', 'port', 'log_level']);
  const paths = r.section(root, 'paths', ['state_dir']);
  const storage = r.section(root, 'storage', [
    'mountpoint', 'root_relative', 'expected_fs_uuid', 'volume_marker', 'fs_type',
    'min_free_percent', 'min_free_bytes', 'health_check_interval_seconds', 'versioning_enabled',
  ]);
  const transfers = r.section(root, 'transfers', [
    'max_concurrent_uploads', 'max_concurrent_downloads', 'chunk_size_mib', 'staging_ttl_hours',
  ]);
  const indexer = r.section(root, 'indexer', ['max_parallel_file_stats', 'scan_interval_minutes', 'hash_only_when_needed']);
  const trash = r.section(root, 'trash', ['enabled', 'retention_days']);
  const security = r.section(root, 'security', ['lan_only_default', 'remote_access_enabled']);

  const config: PcloudConfig = {
    server: {
      host: r.string(server, 'host', 'server', '127.0.0.1', checkHost),
      port: r.number(server, 'port', 'server', 3000, 1, 65535),
      logLevel: r.oneOf(server, 'log_level', 'server', ['fatal', 'error', 'warn', 'info', 'debug', 'trace'], 'info'),
    },
    paths: {
      stateDir: r.string(paths, 'state_dir', 'paths', '/var/lib/pcloud', checkAbsolute),
    },
    storage: {
      mountpoint: r.string(storage, 'mountpoint', 'storage', '/srv/pcloud', checkAbsolute),
      rootRelative: r.string(storage, 'root_relative', 'storage', 'data', checkRootRelative),
      expectedFsUuid: r.nullableString(storage, 'expected_fs_uuid', 'storage', (v) =>
        isFsUuid(v) ? null : 'formato no válido (exFAT "XXXX-XXXX", NTFS 16 hex o UUID estándar); ver lsblk -f',
      ),
      volumeMarker: r.nullableString(storage, 'volume_marker', 'storage', (v) =>
        isVolumeMarkerId(v) ? null : 'debe ser un UUID v4 en minúsculas (lo genera el onboarding)',
      ),
      fsType: r.oneOf(
        storage, 'fs_type', 'storage', ['exfat', 'ntfs3', 'ntfs-3g'], 'exfat',
        ' (debe reflejar el montaje real; "exfat_or_ntfs3" era solo un marcador de la spec)',
      ),
      minFreePercent: r.number(storage, 'min_free_percent', 'storage', 2, 0, 50, false),
      minFreeBytes: r.number(storage, 'min_free_bytes', 'storage', 10 * GiB, 0, Number.MAX_SAFE_INTEGER),
      healthCheckIntervalSeconds: r.number(storage, 'health_check_interval_seconds', 'storage', 5, 1, 300),
      versioningEnabled: r.bool(storage, 'versioning_enabled', 'storage', false),
    },
    transfers: {
      maxConcurrentUploads: r.number(transfers, 'max_concurrent_uploads', 'transfers', 2, 1, 16),
      maxConcurrentDownloads: r.number(transfers, 'max_concurrent_downloads', 'transfers', 2, 1, 16),
      chunkSizeMib: r.number(transfers, 'chunk_size_mib', 'transfers', 8, 1, 64),
      stagingTtlHours: r.number(transfers, 'staging_ttl_hours', 'transfers', 72, 1, 24 * 30),
    },
    indexer: {
      maxParallelFileStats: r.number(indexer, 'max_parallel_file_stats', 'indexer', 2, 1, 32),
      scanIntervalMinutes: r.number(indexer, 'scan_interval_minutes', 'indexer', 60, 1, 7 * 24 * 60),
      hashOnlyWhenNeeded: r.bool(indexer, 'hash_only_when_needed', 'indexer', true),
    },
    trash: {
      enabled: r.bool(trash, 'enabled', 'trash', true),
      retentionDays: r.number(trash, 'retention_days', 'trash', 30, 1, 3650),
    },
    security: {
      lanOnlyDefault: r.bool(security, 'lan_only_default', 'security', true),
      remoteAccessEnabled: r.bool(security, 'remote_access_enabled', 'security', false),
    },
  };

  if (config.storage.volumeMarker !== null && config.storage.expectedFsUuid === null) {
    r.problems.push('storage.volume_marker: requiere storage.expected_fs_uuid');
  }
  if (config.paths.stateDir === config.storage.mountpoint || config.paths.stateDir.startsWith(`${config.storage.mountpoint}/`)) {
    r.problems.push('paths.state_dir: el estado interno (SQLite) debe vivir en la microSD, nunca dentro del HDD');
  }
  if (r.problems.length > 0) throw new ConfigError(source, r.problems);
  return config;
}

export function parseConfig(text: string, source = '<config>'): PcloudConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text, { uniqueKeys: true, strict: true, prettyErrors: true });
  } catch (error) {
    throw new ConfigError(source, [`YAML inválido: ${error instanceof Error ? error.message : String(error)}`]);
  }
  return validateConfig(raw, source);
}

export async function loadConfig(file: string): Promise<PcloudConfig> {
  return parseConfig(await readFile(file, 'utf8'), file);
}
