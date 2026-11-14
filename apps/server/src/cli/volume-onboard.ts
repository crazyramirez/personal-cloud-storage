/**
 * volume-onboard — vincula el volumen montado con esta instalación (crea `.pcloud/`, la raíz de
 * datos y el marcador). Debe ejecutarse como el usuario de servicio `pcloud`.
 *
 * Solo actúa si el StorageGuardian concede un lease de onboarding (montado rw, UUID correcto,
 * sin vincular). Imprime un JSON con el marcador para registrarlo después en la configuración
 * (config-bind-volume.ts, como root). Lo orquesta deploy/linux/setup/pcloud-onboard-volume.sh.
 *
 * Uso: node volume-onboard.ts --config /etc/pcloud/config.yaml --uuid 1A2B-3C4D [--fs-type exfat]
 *                             [--root data] [--adopt-existing]
 * Salida: 0 vinculado, 3 el volumen no está en estado de vinculación, 64 uso, 1 error.
 */

import { parseArgs } from 'node:util';
import { OnboardingError, onboardVolume } from '../storage/onboarding.ts';
import { StorageUnavailableError } from '../storage/storage-guardian.ts';
import { createGuardian, EXIT_NOT_ELIGIBLE, EXIT_USAGE, loadConfigWithOverrides, reportCliError } from './common.ts';

const HELP = `Uso: node volume-onboard.ts --config FICHERO --uuid UUID [--fs-type exfat|ntfs3|ntfs-3g] [--root RELATIVA] [--adopt-existing]`;

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        config: { type: 'string', short: 'c' },
        uuid: { type: 'string' },
        'fs-type': { type: 'string' },
        root: { type: 'string' },
        'adopt-existing': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }).values;
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${HELP}`);
    return EXIT_USAGE;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  try {
    const config = await loadConfigWithOverrides({
      config: args.config,
      uuid: args.uuid,
      fsType: args['fs-type'],
      root: args.root,
    });
    if (config.storage.expectedFsUuid === null) {
      console.error('Falta el UUID del volumen (--uuid o storage.expected_fs_uuid)');
      return EXIT_USAGE;
    }
    const guardian = createGuardian(config);
    const result = await onboardVolume(guardian, { adoptExistingMarker: args['adopt-existing'] });
    console.log(
      JSON.stringify({
        markerId: result.markerId,
        adopted: result.adopted,
        created: result.created,
        fsUuid: config.storage.expectedFsUuid,
        fsType: config.storage.fsType,
      }),
    );
    return 0;
  } catch (error) {
    if (error instanceof StorageUnavailableError) {
      const cause = error.issues[0];
      console.error(`El volumen no está en estado de vinculación (${error.volumeState}${cause ? ` ${cause.code}: ${cause.message}` : ''})`);
      return EXIT_NOT_ELIGIBLE;
    }
    if (error instanceof OnboardingError) {
      console.error(error.message);
      return EXIT_NOT_ELIGIBLE;
    }
    return reportCliError(error);
  }
}

process.exitCode = await main();
