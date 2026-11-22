# ADR-0027: Favoritos por usuario, en la base de datos y que siguen al elemento

Estado: Aceptado (2026-11-22).

## Contexto

Hace falta marcar carpetas y archivos como favoritos para tenerlos a mano: filtrarlos en el explorador, verlos en el Panel, en una página propia y en la barra lateral. El disco de datos es exFAT/NTFS y puede desaparecer en cualquier momento; el mandato principal prohíbe tratar su ausencia como un borrado y escribir en él nada que no sea de la persona.

## Decisión

1. **Dónde:** tabla `favorites (user_id, path, kind, created_at)` en SQLite (microSD, migración 6), con clave `(user_id, path)`. Nada en el disco de datos (ni atributos extendidos, que exFAT no tiene, ni ficheros ocultos). Cada usuario tiene los suyos; se borran con su cuenta (`ON DELETE CASCADE`). Máximo 500 por usuario.
2. **Siguen al elemento:** renombrar o mover desde la web reescribe el prefijo de la ruta en la misma transacción que los enlaces y las subidas (`relocatePaths`, dentro de la cola serie). Con `UPDATE OR REPLACE`: si quedaba un favorito antiguo en la ruta de destino (algo que ya no estaba ahí, porque el rename nunca sobrescribe), cede su sitio.
3. **Nunca se quitan solos.** Si la ruta ya no existe (eliminado, en la papelera, cambiado desde la carpeta de red), la API lo devuelve con `exists: false` y la web lo muestra en «No disponibles», con un botón para quitarlo. Al restaurarlo de la papelera a su sitio vuelve a verse. Con el disco ilegible la lista se sirve igual, con `exists: null` (nombres guardados).
4. **API:** `GET /favorites` (lista con tipo, tamaño y fecha mirados en el disco), `POST /favorites` (añadir: solo lo que existe, idempotente, todo o nada respecto al máximo) y `POST /favorites/remove` (no necesita el disco). Añadir o quitar devuelve la lista completa. No se anota en Actividad: no cambia ningún archivo.
5. **Web:** estrella en el explorador (menú, barra de selección, panel de detalles, título de la carpeta, migas de pan), filtro «Solo favoritos» de la carpeta, estrella en el visor, tarjeta en el Panel, página `/favoritos` (búsqueda, tipo, orden y no disponibles) y «Acceso rápido» con las carpetas favoritas en la barra lateral.

## Consecuencias

- Los favoritos sobreviven a desconexiones del disco, reinicios y cambios de release, y no dejan rastro en el disco de datos.
- Lo que se renombra o mueve fuera de la web (por la carpeta de red o con el disco conectado a otro ordenador) no se sigue: queda como «no disponible» hasta que la persona lo quite o lo vuelva a marcar.
- Restaurar de la papelera a otro nombre (porque el original estaba ocupado) no mueve el favorito: sigue apuntando a la ruta original.
