# ADR-0011 — HTTPS en la red local con Caddy y CA interna

**Estado:** Aceptado · 2026-11-14 · Resuelve la decisión D4 de [SPEC_AUDIT.md](../SPEC_AUDIT.md)

## Contexto

Con HTTP plano, cualquier equipo de la Wi-Fi podría leer la contraseña, la cookie de sesión y los ficheros. La spec prohíbe exponer Fastify o el panel a Internet y usar servicios de terceros, así que Let's Encrypt (que exige un dominio público y validación desde fuera) queda descartado. Los navegadores exigen además un contexto seguro para la cookie `Secure`.

## Decisión

- **Caddy** (paquete de Debian trixie, 2.6.2) delante de Fastify:
  - Fastify escucha solo en `127.0.0.1:3000`. Una unidad systemd con `IPAddressDeny=any` / `IPAddressAllow=localhost` impide además que el proceso acepte o abra conexiones fuera de loopback.
  - Caddy sirve la SPA estática desde `/opt/pcloud/current/apps/web/.output/public` (con fallback a `200.html`) y hace de proxy de `/api/*` sin almacenar los cuerpos.
  - `tls internal` + `local_certs`: CA propia de Caddy con raíz de 10 años e intermedio y hoja de corta duración, que se renuevan solos sin red externa. `skip_install_trust`: no se toca el almacén de confianza del sistema.
  - `admin off`: sin API de administración local. Los cambios se aplican con `systemctl restart caddy`.
  - Solo se atienden los nombres configurados: `<host>.local`, `<host>` y la IPv4 actual. Un `Host` desconocido no llega nunca a la API (protección contra DNS rebinding).
  - Sin registro de accesos, para no escribir de forma continua en la microSD.
  - Cabeceras: `X-Frame-Options DENY`, `frame-ancestors 'none'`, `Referrer-Policy no-referrer`, COOP/CORP `same-origin`, `Permissions-Policy` restrictiva y `nosniff`. La CSP de la SPA va en `<meta>` con hashes de los scripts en línea, calculados en cada build (`apps/web/scripts/apply-csp.mjs`).
  - HTTP en el puerto 80 redirige a HTTPS (308).
- El certificado raíz (solo la parte pública) se publica en `https://<host>.local/pcloud-ca.crt` para instalarlo en los dispositivos propios. Cada instalación genera su propia CA; su huella SHA-256 se consulta en el servidor ([OPERATIONS §4 bis](../OPERATIONS.md#4-bis-acceso-a-la-web-y-primera-configuración)).
- La configuración se genera desde `deploy/linux/caddy/Caddyfile.tmpl` con `pcloud-install-caddy.sh`. El script es dry-run por defecto e idempotente; valida como el usuario `caddy` antes de sustituir y comprueba HTTPS de extremo a extremo con verificación real del certificado.
- Fastify confía en `X-Forwarded-*` solo si vienen de `127.0.0.1` (`trustProxy`), y marca la cookie como `Secure` cuando el protocolo original es HTTPS.

## Consecuencias

- Hasta que se instala la CA en cada dispositivo, el navegador muestra un aviso de certificado. Hay que comprobar la huella antes de instalarla.
- Si cambia la IP (DHCP), hay que volver a ejecutar `pcloud-install-caddy.sh --execute`; `<host>.local` sigue funcionando por mDNS. Se recomienda reservar la IP en el router.
- La clave privada de la CA vive en `/var/lib/caddy` (microSD). Perderla obliga a reinstalar la nueva raíz en los dispositivos. Su copia de seguridad forma parte de S1.7.
- Caddy consume ~42 MB de RSS en reposo.

## Alternativas descartadas

- **TLS en Fastify:** habría que gestionar a mano la CA, las renovaciones y la SPA estática. Además pondría la clave privada al alcance del proceso que procesa entradas no confiables.
- **nginx + certificado autofirmado:** mismo aviso en el navegador, sin renovación automática y con más configuración manual.
- **Let's Encrypt con DNS-01:** exige un dominio público y un proveedor DNS externo, contrario a la spec en la fase LAN.
- **HTTP plano en la LAN:** credenciales y ficheros en claro en la Wi-Fi.
