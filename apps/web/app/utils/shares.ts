import type { GatewayView } from '@pcloud/contracts';

/** Frase del estado de la puerta de invitados (acceso a los enlaces desde Internet). */
export function gatewayText(view: GatewayView): string {
  switch (view.state) {
    case 'on':
      return t('shares.gwOn');
    case 'starting':
      return t('shares.gwStarting');
    case 'needs_funnel':
      return view.enableUrl === null ? t('shares.gwNeedsFunnelNoLink') : t('shares.gwNeedsFunnel');
    case 'needs_https':
      return t('shares.gwNeedsHttps');
    case 'no_tailscale':
      return t('shares.gwNoTailscale');
    case 'unavailable':
      return t('shares.gwUnavailable');
    case 'error':
      return t('shares.gwError');
    default:
      return t('shares.gwOff');
  }
}
