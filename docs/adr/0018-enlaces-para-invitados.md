# ADR-0018: Enlaces para compartir con invitados (puerta de invitados por Tailscale Funnel)

Estado: Aceptado (2026-11-14). Sustituido en parte por [ADR-0019](0019-nodo-tailscale-dedicado-enlaces.md) (Funnel en un nodo dedicado) y por [ADR-0031](0031-ver-enlaces-compartidos-en-el-navegador.md) (ver en el navegador, no solo descargar). Sustituye en parte a [ADR-0016](0016-acceso-remoto-tailscale.md): la regla «nunca `tailscale funnel`» admite UNA excepción, la puerta de invitados descrita aquí.

## Contexto

El propietario quiere compartir de vez en cuando un archivo o una carpeta (una película, las fotos de un viaje) con un amigo o un familiar que no tiene cuenta, no está en casa y no va a instalar Tailscale ni darse de alta en nada. La regla 4 de AGENTS.md y el ADR-0016 prohíben exponer el servidor a Internet: la app solo es accesible en la LAN y por la VPN de Tailscale.

No se puede llegar a la Pi desde Internet sin que algo sea accesible desde Internet. El propietario aceptó exponer **solo** una puerta mínima, apagada por defecto. No necesita streaming: solo descargar.

## Decisión

1. **Puerta de invitados separada de la app.** Una instancia de Fastify aparte (`apps/server/src/share/guest-app.ts`), en el mismo proceso pero con su propio router. Solo existen `GET/POST /s/<token>`, `GET /s/<token>/f`, `GET /s/<token>/zip` y `/robots.txt`. No hay sesión, inicio de sesión, API, escritura ni listado fuera de lo compartido. Todo lo demás devuelve 404.
2. **Escucha en un socket Unix** (`/var/lib/pcloud/share-agent/guest.sock`, pcloud 0600 dentro de un directorio 0700), no en un puerto: no es alcanzable ni por TCP local. Solo conecta tailscaled (root).
3. **Tailscale Funnel solo mientras haya enlaces activos.** `ShareGateway` (en pcloud.service) pide `on`/`off` a un agente root mínimo (`deploy/linux/share/pcloud-share-agent.sh`, activado por `.path` sobre un buzón, como el de la copia de seguridad). El agente solo sabe publicar o retirar `unix:<socket>` en `https://<host>.<tailnet>.ts.net:8443`. El 443 (Caddy, la app) nunca se publica. Funnel se apaga solo al revocarse, caducar o agotarse el último enlace (comprobación cada minuto). No se abre ningún puerto del router.
4. **Enlaces de solo lectura con caducidad obligatoria** (1, 7 o 30 días). Opcionalmente, una contraseña (Argon2id) y, para archivos, un límite de 1, 3 o 10 descargas. En una carpeta cada archivo contaría como una descarga, así que allí no hay límite. No se puede compartir la raíz.
5. **Token de 256 bits** (base64url, 43 caracteres) que solo existe en el enlace. En la base se guarda su SHA-256, como las sesiones. El enlace solo se muestra al crearlo.
6. **Sin pistas:** «no existe», «caducado», «revocado» y «agotado» dan exactamente la misma respuesta (404).
7. **Rutas** resueltas por componentes dentro de lo compartido (`resolveInside`: sin `..`, sin enlaces simbólicos, mismo dispositivo). Un enlace de archivo siempre sirve ese archivo e ignora `?p=`.
8. **Páginas HTML generadas en el servidor, sin JavaScript.** CSP `default-src 'none'` con estilo por nonce y `form-action 'self'`. También: `frame-ancestors 'none'`, `Referrer-Policy: no-referrer` (el token no se filtra) y `X-Robots-Tag: noindex`. Las descargas van como `attachment`, con `CSP: sandbox` y `nosniff`. HEAD desactivado para que no cuente como descarga.
9. **Límites:**
   - 240 peticiones/min por IP;
   - contraseña: 5 fallos por IP y enlace cada 15 min, 20 fallos por enlace y hora, y una sola verificación Argon2 a la vez;
   - 4 descargas simultáneas en total.

   La IP es la ÚLTIMA entrada de `X-Forwarded-For`, la que añade tailscaled: lo que el invitado ponga delante no cuenta.
10. **Disco:** cada lectura pasa por el StorageGuardian. Sin disco, la página dice «No disponible en este momento» (503), nunca una carpeta vacía.
11. **Trazabilidad:** contadores por enlace (descargas, bytes, último acceso) y auditoría (`share.create`, `share.revoke`, `share.download`, `share.unlock` denegado). En Ajustes → Enlaces compartidos se ven todos los enlaces y se pueden retirar al instante.

## Consecuencias

- **Una vez:** el propietario tiene que permitir Funnel para la Pi en su cuenta de Tailscale. La primera vez, la app muestra el enlace que da Tailscale y el estado `needs_funnel`. También hace falta «HTTPS Certificates», que ya se activó para el ADR-0016.
- **Superficie expuesta:** mientras hay enlaces activos, `https://<host>.<tailnet>.ts.net:8443` es público. El nombre aparece en los registros públicos de certificados, así que llegarán bots; solo encontrarán 404. Cuando no quedan enlaces activos, no hay nada publicado.
- **Velocidad:** la limita la subida de la conexión de casa y el relé de Funnel. Para una película se recomienda probar antes.
- **Riesgo residual:** un fallo en el código de la puerta de invitados está en el mismo proceso que la app. Se mitiga así: router aparte, superficie de unas pocas rutas, sin JavaScript, socket inaccesible por TCP y el aislamiento systemd de pcloud.service.
- El token perdido no se recupera: se crea otro enlace.

## Alternativas descartadas

- **Proceso aparte con su propio usuario y el disco en solo lectura:** necesitaría un segundo StorageGuardian sobre el mismo disco y acceso compartido a la base. Una vista de solo lectura de `/srv/pcloud` montada por systemd ocultaría el disco si se conecta después de arrancar (ver pcloud.service). Más complejo y frágil.
- **Exponer la app completa por Funnel:** dejaría el inicio de sesión y la API a merced de ataques automatizados.
- **Que el invitado use Tailscale (compartir el nodo):** obliga a darse de alta e instalar una app; el propietario lo descartó.
- **Copia cifrada en almacenamiento externo (R2/B2):** máxima privacidad, pero requiere cuenta de terceros, subir antes el archivo entero y no permite navegar carpetas. Queda como posible modo futuro.
- **Cloudflare Tunnel:** requiere dominio propio y Cloudflare descifra el tráfico.
