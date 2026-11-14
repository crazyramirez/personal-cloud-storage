/**
 * Registra en config.yaml el volumen vinculado (UUID del FS, marcador y controlador), conservando
 * comentarios y formato. Se niega a sustituir en silencio un volumen ya vinculado distinto:
 * cambiar de disco es un acto explícito de administración.
 */

import { parseDocument } from 'yaml';
import type { ConfiguredFsType } from '../storage/storage-guardian.ts';
import { ConfigError, validateConfig, type PcloudConfig } from './config.ts';

export interface VolumeBinding {
  readonly fsUuid: string;
  readonly volumeMarker: string;
  readonly fsType: ConfiguredFsType;
}

export interface BindResult {
  readonly text: string;
  readonly changed: boolean;
  readonly config: PcloudConfig;
}

function parseStrict(text: string, source: string) {
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: true });
  if (doc.errors.length > 0) throw new ConfigError(source, doc.errors.map((error) => `YAML inválido: ${error.message}`));
  return doc;
}

export function bindVolumeInYaml(text: string, binding: VolumeBinding, source = '<config>'): BindResult {
  const doc = parseStrict(text, source);
  const current = validateConfig(doc.toJS(), source);
  const storage = current.storage;

  const conflicts: string[] = [];
  if (storage.expectedFsUuid !== null && storage.expectedFsUuid !== binding.fsUuid) {
    conflicts.push(`storage.expected_fs_uuid ya vale ${storage.expectedFsUuid} (se pidió ${binding.fsUuid})`);
  }
  if (storage.volumeMarker !== null && storage.volumeMarker !== binding.volumeMarker) {
    conflicts.push(`storage.volume_marker ya vale ${storage.volumeMarker} (se pidió ${binding.volumeMarker})`);
  }
  if (conflicts.length > 0) {
    throw new ConfigError(source, [...conflicts, 'ya hay otro volumen vinculado: desvincúlalo explícitamente antes']);
  }

  const changed =
    storage.expectedFsUuid !== binding.fsUuid ||
    storage.volumeMarker !== binding.volumeMarker ||
    storage.fsType !== binding.fsType;
  if (!changed) return { text, changed: false, config: current };

  doc.setIn(['storage', 'expected_fs_uuid'], binding.fsUuid);
  doc.setIn(['storage', 'volume_marker'], binding.volumeMarker);
  doc.setIn(['storage', 'fs_type'], binding.fsType);
  const output = doc.toString();
  // Revalidar el resultado serializado: garantiza que el fichero escrito es exactamente válido.
  const config = validateConfig(parseStrict(output, source).toJS(), source);
  if (
    config.storage.expectedFsUuid !== binding.fsUuid ||
    config.storage.volumeMarker !== binding.volumeMarker ||
    config.storage.fsType !== binding.fsType
  ) {
    throw new ConfigError(source, ['la configuración serializada no conserva los valores pedidos']);
  }
  return { text: output, changed: true, config };
}
