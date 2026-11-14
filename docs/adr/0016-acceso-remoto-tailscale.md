# ADR-0016 — Acceso desde Internet por Tailscale (VPN privada)

**Estado:** Aceptado · 2026-11-14 · Complementa [ADR-0011](0011-https-lan-caddy.md)

## Contexto

El propietario quiere usar su nube fuera de casa. La spec prohíbe exponer Fastify o la web directamente a Internet. La red de referencia tiene doble NAT (router doméstico → router del operador), con IP pública pero sin CGNAT. Un WireGuard propio exigiría abrir y reenviar un puerto UDP en los dos routers y mantener un DNS dinámico. El propietario eligió Tailscale.

## Decisión

- **Tailscale** en la Pi, instalado desde el repositorio oficial con firma verificada por apt (`deploy/linux/setup/pcloud-install-tailscale.sh`). El nodo toma el nombre del equipo (`<host>`), con el nombre MagicDNS `<host>.<tailnet>.ts.net` y una IP 100.x.
- **Nunca se usa `tailscale funnel` ni `serve`.** Solo llegan los dispositivos autorizados en la cuenta Tailscale del propietario. No se abre ningún puerto en los routers.
- `--ssh=false`: el SSH de Tailscale queda desactivado y el acceso administrativo sigue siendo el SSH con clave de la LAN. `--accept-dns=false`: la Pi no cambia su DNS.
- **Certificado válido:** con «HTTPS Certificates» activado en la consola de la cuenta, tailscaled obtiene un certificado de Let's Encrypt para `*.ts.net`. Lo consigue mediante el desafío DNS-01 que gestiona Tailscale, sin exponer nada. `TS_PERMIT_CERT_UID=caddy` permite a Caddy pedirlo directamente a tailscaled.
- **Caddyfile:** la aplicación pasa a ser un snippet `(pcloud_app)` que importan dos sitios:
  - la LAN (`tls internal`; nombres `<host>.local`, `<host>` y las IPv4, incluida la 100.x de Tailscale);
  - `<host>.<tailnet>.ts.net`, que Caddy sirve con el certificado de Tailscale.

  `pcloud-install-caddy.sh` detecta el nombre en `tailscale status --json` (`CertDomains`) y añade el sitio automáticamente. La protección contra DNS rebinding se mantiene: solo se atienden nombres listados.
- La interfaz indica cuándo se entra por Tailscale: la barra lateral muestra «vía Tailscale» y el Panel describe el alcance real del acceso.

## Consecuencias

- Fuera de casa: abrir la app Tailscale (iPhone, Android, Windows, macOS), iniciar sesión con la misma cuenta y entrar en `https://<host>.<tailnet>.ts.net/`. No hace falta instalar la CA interna en esos dispositivos.
- Las llaves de acceso (passkeys) están ligadas al dominio. Las registradas en `<host>.local` no sirven en `*.ts.net` y hay que registrar otra desde ese nombre. La contraseña funciona en ambos.
- La sesión (cookie) es por nombre de host: hay que entrar una vez por cada nombre.
- Dependencia de un servicio de coordinación externo (Tailscale). Si cae, el tráfico de los nodos ya conectados sigue funcionando, pero sin el servicio no se pueden autorizar dispositivos nuevos. La LAN no depende de Tailscale.
- El certificado de `ts.net` lo renueva tailscaled/Caddy solo, cada ~90 días. El primer acceso tras emitirlo puede tardar unos segundos.
- Al rendimiento lo limita la subida del operador. Con conexión directa (sin relé DERP), WireGuard en la Pi 4 no es el cuello de botella.

## Alternativas descartadas

- **WireGuard propio:** requiere reenviar un puerto en dos routers (doble NAT), mantener un DNS dinámico y gestionar las claves de cada dispositivo. Fue elegido inicialmente y el propietario lo cambió por Tailscale.
- **Tailscale Funnel / túneles públicos (Cloudflare Tunnel):** publicarían la web en Internet, algo prohibido por la spec.
- **Abrir el 443 en el router:** igualmente prohibido; dejaría la API expuesta a ataques automatizados.
