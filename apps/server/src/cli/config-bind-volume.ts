/**
 * config-bind-volume — registra en config.yaml el volumen vinculado (UUID, marcador y controlador).
 * Debe ejecutarse como root (escribe /etc/pcloud/config.yaml conservando root:pcloud 0640).
 *
 * Antes de escribir, comprueba con el StorageGuardian que ESA combinación de UUID y marcador
 * describe el volumen montado ahora mismo (estado READY). Nunca sustituye en silencio otro volumen
 * ya vinculado. Escritura atómica; conserva comentarios.
 *
 * Uso: node config-bind-volume.ts --config /etc/pcloud/config.yaml --uuid 1A2B-3C4D --marker ID [--fs-type exfat]
 * Salida: 0 escrito o ya estaba, 3 el volumen no confirma la vinculación, 64 uso, 1 error.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { bindVolumeInYaml } from '../config/bind-volume.ts';
import { writeFileAtomic } from '../fs/durability.ts';
import { isFsUuid, type ConfiguredFsType } from '../storage/storage-guardian.ts';
import { isVolumeMarkerId } from '../storage/volume-marker.ts';
import { createGuardian, EXIT_NOT_ELIGIBLE, EXIT_USAGE, loadConfigWithOverrides, reportCliError } from './common.ts';

const HELP = 'Uso: node config-bind-volume.ts --config FICHERO --uuid UUID --marker ID [--fs-type exfat|ntfs3|ntfs-3g]';
const FS_TYPES: readonly ConfiguredFsType[] = ['exfat', 'ntfs3', 'ntfs-3g'];

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        config: { type: 'string', short: 'c' },
        uuid: { type: 'string' },
        marker: { type: 'string' },
        'fs-type': { type: 'string', default: 'exfat' },
      },
      strict: true,
    }).values;
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${HELP}`);
    return EXIT_USAGE;
  }
  const { config: configPath, uuid, marker } = args;
  const fsType = args['fs-type'] as ConfiguredFsType;
  if (configPath === undefined || uuid === undefined || marker === undefined || !FS_TYPES.includes(fsType)) {
    console.error(HELP);
    return EXIT_USAGE;
  }
  if (!isFsUuid(uuid) || !isVolumeMarkerId(marker)) {
    console.error('UUID o marcador con formato no válido');
    return EXIT_USAGE;
  }

  try {
    // 1. ¿Describe esta vinculación el volumen montado ahora mismo?
    const proposed = await loadConfigWithOverrides({ config: configPath, uuid, marker, fsType });
    const snapshot = await createGuardian(proposed).check();
    if (snapshot.state !== 'READY') {
      const cause = snapshot.issues[0];
      console.error(
        `La vinculación propuesta no deja el volumen en READY (${snapshot.state}${cause ? ` ${cause.code}: ${cause.message}` : ''}). ` +
          'No se modifica la configuración.',
      );
      return EXIT_NOT_ELIGIBLE;
    }

    // 2. Escribir conservando comentarios; rechaza sustituir otro volumen.
    const original = await readFile(configPath, 'utf8');
    const result = bindVolumeInYaml(original, { fsUuid: uuid, volumeMarker: marker, fsType }, configPath);
    if (!result.changed) {
      console.log(`${configPath} ya tenía esta vinculación: sin cambios.`);
      return 0;
    }
    await writeFileAtomic(configPath, result.text);
    console.log(`Vinculado en ${configPath}: expected_fs_uuid=${uuid} volume_marker=${marker} fs_type=${fsType}`);
    return 0;
  } catch (error) {
    return reportCliError(error);
  }
}

process.exitCode = await main();
