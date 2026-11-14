/**
 * Utilidades compartidas por las CLIs de operación.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { ConfigError, validateConfig, type PcloudConfig } from '../config/config.ts';
import { LinuxStorageProbe } from '../storage/linux-probe.ts';
import type { StorageProbe } from '../storage/probe.ts';
import { StorageGuardian } from '../storage/storage-guardian.ts';

export const EXIT_USAGE = 64;
export const EXIT_NOT_ELIGIBLE = 3;

export interface StorageOverrides {
  readonly config?: string | undefined;
  readonly uuid?: string | undefined;
  readonly fsType?: string | undefined;
  readonly mountpoint?: string | undefined;
  /** "none" equivale a null. */
  readonly marker?: string | undefined;
  readonly root?: string | undefined;
}

/** Carga config.yaml (si se indica) y aplica los overrides de storage; valida el resultado. */
export async function loadConfigWithOverrides(overrides: StorageOverrides): Promise<PcloudConfig> {
  const raw: Record<string, unknown> =
    overrides.config === undefined
      ? {}
      : ((parseYaml(await readFile(overrides.config, 'utf8'), { uniqueKeys: true }) as Record<string, unknown> | null) ?? {});
  const storage = { ...((raw['storage'] as Record<string, unknown> | undefined) ?? {}) };
  if (overrides.uuid !== undefined) storage['expected_fs_uuid'] = overrides.uuid;
  if (overrides.fsType !== undefined) storage['fs_type'] = overrides.fsType;
  if (overrides.mountpoint !== undefined) storage['mountpoint'] = overrides.mountpoint;
  if (overrides.marker !== undefined) storage['volume_marker'] = overrides.marker === 'none' ? null : overrides.marker;
  if (overrides.root !== undefined) storage['root_relative'] = overrides.root;
  return validateConfig({ ...raw, storage }, overrides.config ?? '<línea de comandos>');
}

export function createGuardian(config: PcloudConfig, probe: StorageProbe = new LinuxStorageProbe()): StorageGuardian {
  return new StorageGuardian({
    mountpoint: config.storage.mountpoint,
    expectedFsUuid: config.storage.expectedFsUuid,
    fsType: config.storage.fsType,
    volumeMarker: config.storage.volumeMarker,
    dataRootRelative: config.storage.rootRelative,
    probe,
  });
}

/** Imprime errores de configuración/uso de forma legible y devuelve el código de salida. */
export function reportCliError(error: unknown): number {
  if (error instanceof ConfigError) {
    console.error(error.message);
    return EXIT_USAGE;
  }
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  return 1;
}
