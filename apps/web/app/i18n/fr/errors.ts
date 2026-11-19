import type { Translation } from '~/utils/i18n';
import type source from '../errors';

export default {
  VALIDATION_FAILED: 'La requête n’est pas valide',
  INVALID_PATH: 'Le chemin n’est pas valide',
  INVALID_NAME: 'Le nom n’est pas valide',
  UNAUTHENTICATED: 'Votre session a expiré : reconnectez-vous',
  FORBIDDEN: 'Vous n’êtes pas autorisé à faire cela',
  NOT_FOUND: 'Introuvable (l’élément a peut-être été déplacé ou supprimé)',
  CONFLICT: 'Conflit avec un élément existant',
  OFFSET_MISMATCH: 'L’importation s’est désynchronisée ; elle va reprendre',
  PRECONDITION_FAILED: 'L’élément a été modifié entre-temps',
  PAYLOAD_TOO_LARGE: 'C’est trop volumineux',
  UNSUPPORTED_MEDIA: 'Impossible d’afficher ce type de fichier',
  RANGE_NOT_SATISFIABLE: 'Plage demandée non valide',
  CHECKSUM_MISMATCH: 'Le fichier est arrivé endommagé ; l’importation va être relancée',
  LOCKED: 'Utilisé par une autre opération',
  RATE_LIMITED: 'Trop de tentatives : patientez un instant',
  INTERNAL: 'Erreur interne du serveur',
  STORAGE_UNAVAILABLE: 'Le disque n’est pas disponible',
  INSUFFICIENT_STORAGE: 'Le disque est plein',
  NETWORK: 'Impossible de joindre le serveur',
  TIMEOUT: 'Le serveur ne répond pas. Réessayez dans quelques secondes.',
  httpStatus: 'Erreur {status}',
} satisfies Translation<typeof source>;
