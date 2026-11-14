# ADR-0019: Nodo Tailscale dedicado para la puerta de invitados

Estado: Aceptado (2026-11-14). Sustituye en parte a [ADR-0018](0018-enlaces-para-invitados.md): Funnel ya no va en el nodo de la app, en `:8443`, sino en un nodo aparte, en `:443`.

## Contexto

Con el ADR-0018, Funnel publicaba la puerta de invitados en `https://<host>.<tailnet>.ts.net:8443`, el mismo nombre que la app. Activar Funnel en un nodo hace que su nombre exista en el **DNS público**, y ahí apunta a los servidores de Funnel de Tailscale, que solo atienden los puertos publicados.

Consecuencia observada: un iPhone con «Limitar seguimiento de IP» (o Relay privado de iCloud) resuelve el nombre por DNS público en lugar de por MagicDNS. Llega a los servidores de Funnel, el puerto 443 no está publicado y la app deja de abrirse («No se puede conectar con el servidor»). En el ordenador, que usa MagicDNS, seguía funcionando.

## Decisión

- **Un segundo `tailscaled` en la Pi** (`pcloud-share-tailscaled.service`), en modo userspace (sin interfaz, rutas ni DNS), con su propio estado (`/var/lib/pcloud-share-ts`) y su propio socket (`/run/pcloud-share-ts/tailscaled.sock`). Se une a la cuenta como `<host>-compartir`.
- **Funnel solo en ese nodo**, en `:443`, hacia el socket de la puerta de invitados. Los enlaces quedan `https://<host>-compartir.<tailnet>.ts.net/s/<token>`. El nombre de la app no vuelve a publicarse.
- **Alta del nodo, una sola vez:** si no ha iniciado sesión, el agente devuelve `NEEDS_LOGIN` con la URL de Tailscale (`login.tailscale.com/a/…`). La app la muestra («Conectar en Tailscale»); la persona inicia sesión y acepta. Se pide `--accept-dns=false --accept-routes=false --ssh=false`.
- **Limpieza:** el agente retira en cada ejecución cualquier Funnel en `:8443` del nodo principal (versión anterior).
- Lo demás del ADR-0018 no cambia: Funnel solo mientras haya enlaces activos, puerta de invitados mínima en un socket Unix y agente root por buzón.

## Consecuencias

- La cuenta de Tailscale tiene un dispositivo más (`<host>-compartir`). Conviene desactivar la caducidad de su clave en la consola («Disable key expiry»); si no, los enlaces dejan de abrirse a los ~180 días hasta volver a iniciar sesión.
- El permiso de Funnel (nodeAttrs) debe cubrir también este nodo. El que añade el enlace de Tailscale suele aplicarse a todos los miembros; si no, la app vuelve a mostrar «Permitir en Tailscale».
- El registro DNS público que ya se creó para `<host>` puede tardar en desaparecer, o no hacerlo. Mientras tanto, los dispositivos que resuelvan por DNS público necesitan MagicDNS («Use Tailscale DNS») o desactivar «Limitar seguimiento de IP».
- El nodo userspace no da acceso a la Pi: no tiene interfaz de red ni servicios propios; solo sirve lo que publica Funnel.

## Alternativas descartadas

- **Funnel en el nodo de la app, en otro puerto:** es lo que provocó el problema; el nombre se vuelve público.
- **Exigir MagicDNS en todos los dispositivos:** frágil (Relay privado, «Limitar seguimiento de IP», ajustes por red Wi-Fi o datos móviles) y fuera del control de la app.
- **Renombrar el nodo de la app:** obligaría a reinstalar la app en los dispositivos y a crear de nuevo las llaves de acceso.
