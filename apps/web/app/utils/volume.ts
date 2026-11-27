import { volumeRepairActive, type StorageResponse, type VolumeState } from '@pcloud/contracts';

export type Tone = 'ok' | 'warn' | 'danger' | 'muted';

/** Etiqueta reactiva: los textos se leen al acceder (siguen el idioma activo). */
function label(pill: () => string, widget: () => string, tone: Tone): { readonly pill: string; readonly widget: string; tone: Tone } {
  return {
    get pill() {
      return pill();
    },
    get widget() {
      return widget();
    },
    tone,
  };
}

/** Etiquetas cortas del estado del disco para la barra superior y el lateral. */
export const VOLUME_LABELS: Record<VolumeState, { pill: string; widget: string; tone: Tone }> = {
  INITIALIZING: label(() => t('volume.initializingPill'), () => t('volume.initializingWidget'), 'muted'),
  READY: label(() => t('volume.readyPill'), () => t('volume.readyWidget'), 'ok'),
  READ_ONLY: label(() => t('volume.readOnly'), () => t('volume.readOnly'), 'warn'),
  UNAVAILABLE: label(() => t('volume.unavailablePill'), () => t('volume.unavailableWidget'), 'danger'),
  WRONG_VOLUME: label(() => t('volume.wrongPill'), () => t('volume.wrongWidget'), 'danger'),
  NEEDS_CHECK: label(() => t('volume.needsCheckPill'), () => t('volume.needsCheckWidget'), 'warn'),
  UNHEALTHY: label(() => t('volume.unhealthyPill'), () => t('volume.unhealthyWidget'), 'danger'),
};

const REPAIRING = label(() => t('volume.repairingPill'), () => t('volume.repairingWidget'), 'warn');

/** ¿Se está reparando el disco y por eso no está listo? (ADR-0032) */
export function volumeRepairing(status: StorageResponse | null): boolean {
  return status !== null && status.state !== 'READY' && volumeRepairActive(status.repair);
}

/** Etiqueta corta según el estado y, si se está reparando, «Reparando el disco…». */
export function volumeLabel(status: StorageResponse | null): { pill: string; widget: string; tone: Tone } {
  return volumeRepairing(status) ? REPAIRING : VOLUME_LABELS[status?.state ?? 'INITIALIZING'];
}

export interface VolumeExplanation {
  tone: Tone;
  title: string;
  lead: string;
  steps: string[];
  effects: Array<{ ok: boolean; title: string; text: string }>;
  canBrowse: boolean;
}

function systemCard(): { ok: boolean; title: string; text: string } {
  return { ok: true, title: t('volume.systemCardTitle'), text: t('volume.systemCardText') };
}

/**
 * Explicación para la pantalla «disco no disponible»: nunca se confunde con una carpeta vacía (spec §9.9).
 * Se llama durante el render (computed), así que los textos siguen el idioma activo.
 */
export function explainVolume(status: StorageResponse | null): VolumeExplanation {
  if (volumeRepairing(status)) {
    return {
      tone: 'warn',
      title: t('volume.repairingTitle'),
      lead: status?.repair?.trigger === 'readonly' ? t('volume.repairingLeadReadOnly') : t('volume.repairingLead'),
      steps: [t('volume.repairingStep1'), t('volume.repairingStep2')],
      effects: [
        { ok: false, title: t('volume.effectCloud'), text: t('volume.repairingEffectCloud') },
        { ok: true, title: t('volume.repairingEffectFilesTitle'), text: t('volume.repairingEffectFilesText') },
        systemCard(),
      ],
      canBrowse: false,
    };
  }
  if (status?.state === 'READ_ONLY' && status.repair?.phase === 'failed') {
    return {
      tone: 'danger',
      title: t('volume.repairFailedTitle'),
      lead: t('volume.repairFailedLead'),
      steps: [t('volume.repairFailedStep1'), t('volume.repairFailedStep2'), t('volume.repairFailedStep3')],
      effects: [
        { ok: true, title: t('volume.readOnlyEffectViewTitle'), text: t('volume.readOnlyEffectViewText') },
        { ok: false, title: t('volume.effectChanges'), text: t('volume.repairFailedEffectChanges') },
      ],
      canBrowse: true,
    };
  }
  switch (status?.state ?? 'INITIALIZING') {
    case 'WRONG_VOLUME':
      return {
        tone: 'danger',
        title: t('volume.wrongTitle'),
        lead: t('volume.wrongLead'),
        steps: [t('volume.wrongStep1'), t('volume.wrongStep2'), t('volume.wrongStep3')],
        effects: [
          { ok: false, title: t('volume.effectCloud'), text: t('volume.wrongEffectCloud') },
          { ok: true, title: t('volume.wrongEffectForeignTitle'), text: t('volume.wrongEffectForeignText') },
          systemCard(),
        ],
        canBrowse: false,
      };
    case 'READ_ONLY':
      return {
        tone: 'warn',
        title: t('volume.readOnlyTitle'),
        lead: t('volume.readOnlyLead'),
        steps: [t('volume.readOnlyStep1'), t('volume.readOnlyStep2'), t('volume.readOnlyStep3')],
        effects: [
          { ok: true, title: t('volume.readOnlyEffectViewTitle'), text: t('volume.readOnlyEffectViewText') },
          { ok: false, title: t('volume.effectChanges'), text: t('volume.readOnlyEffectChanges') },
          { ok: true, title: t('volume.readOnlyEffectPendingTitle'), text: t('volume.readOnlyEffectPendingText') },
        ],
        canBrowse: true,
      };
    case 'UNHEALTHY':
      if (status?.issues[0]?.code === 'IO_STALLED' || status?.issues[0]?.code === 'IO_TIMEOUT') {
        return {
          tone: 'danger',
          title: t('volume.stalledTitle'),
          lead: t('volume.stalledLead'),
          steps: [t('volume.stalledStep1'), t('volume.stalledStep2'), t('volume.stalledStep3')],
          effects: [
            { ok: false, title: t('volume.effectChanges'), text: t('volume.stalledEffectChanges') },
            { ok: false, title: t('volume.stalledEffectViewersTitle'), text: t('volume.stalledEffectViewersText') },
            systemCard(),
          ],
          canBrowse: false,
        };
      }
      return {
        tone: 'danger',
        title: t('volume.unhealthyTitle'),
        lead: t('volume.unhealthyLead'),
        steps: [t('volume.unhealthyStep1'), t('volume.unhealthyStep2'), t('volume.unhealthyStep3')],
        effects: [
          { ok: false, title: t('volume.effectChanges'), text: t('volume.unhealthyEffectChanges') },
          { ok: false, title: t('volume.effectDownloads'), text: t('volume.unhealthyEffectDownloads') },
          systemCard(),
        ],
        canBrowse: false,
      };
    case 'NEEDS_CHECK':
      return {
        tone: 'warn',
        title: t('volume.needsCheckTitle'),
        lead: t('volume.needsCheckLead'),
        steps: [t('volume.needsCheckStep1'), t('volume.needsCheckStep2'), t('volume.needsCheckStep3')],
        effects: [
          { ok: false, title: t('volume.effectCloud'), text: t('volume.needsCheckEffectCloud') },
          systemCard(),
        ],
        canBrowse: false,
      };
    case 'INITIALIZING':
      return {
        tone: 'muted',
        title: t('volume.initializingTitle'),
        lead: t('volume.initializingLead'),
        steps: [],
        effects: [],
        canBrowse: false,
      };
    default:
      return {
        tone: 'danger',
        title: t('volume.unavailableTitle'),
        lead: t('volume.unavailableLead'),
        steps: [t('volume.unavailableStep1'), t('volume.unavailableStep2'), t('volume.unavailableStep3')],
        effects: [
          { ok: false, title: t('volume.effectChanges'), text: t('volume.unavailableEffectChanges') },
          { ok: false, title: t('volume.effectDownloads'), text: t('volume.unavailableEffectDownloads') },
          systemCard(),
        ],
        canBrowse: false,
      };
  }
}
