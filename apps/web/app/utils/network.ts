/** Entrando por Tailscale (nombre *.ts.net o IP 100.64.0.0/10): fuera de casa, por la VPN privada. */
export function isTailscaleHost(hostname: string): boolean {
  return /\.ts\.net$|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname);
}

/** La página actual se abrió por Tailscale (siempre falso fuera del navegador). */
export const viaTailscale = (): boolean => import.meta.client && isTailscaleHost(window.location.hostname);
