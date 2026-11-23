# ADR-0028: Orden personalizado de los favoritos

Estado: Aceptado (2026-11-23). Amplía [ADR-0027](0027-favoritos.md).

## Contexto

Los favoritos se mostraban siempre por fecha (lo último marcado primero) o por un criterio de la web (nombre, modificación). La persona quiere colocarlos a mano, arrastrándolos, y que el acceso rápido de la barra lateral (las carpetas favoritas) siga ese mismo orden en todos sus dispositivos.

## Decisión

1. **Columna `position`** en `favorites` (migración 7), por usuario. Se inicializa con el orden que ya se veía (`created_at` descendente), así que nada cambia al actualizar. Lo nuevo entra al principio (posición menor que la mínima).
2. **`POST /favorites/order`** con la lista de rutas en el orden nuevo: esas primero, en ese orden; las que no se nombran, detrás como estaban. Las rutas desconocidas se ignoran. No necesita el disco. `GET /favorites` devuelve las entradas en el orden personalizado. Renombrar o mover conserva la posición.
3. **Web:** «Orden personalizado» es el primer criterio y el de partida. Con el ratón, se arrastra. En pantallas táctiles, mantener pulsado abre el menú, como en el resto de la app; al mover el dedo, el menú se cierra y empieza el arrastre. Al soltar se guarda y se selecciona «Orden personalizado». Si había un filtro o el Panel solo muestra una parte, los visibles se reparten en los huecos que ya ocupaban y lo demás no se mueve. Si estaba ordenado por otro criterio, ese orden pasa a ser el personalizado. También en el menú: «Mover antes» / «Mover después» (y Alt+flechas).

## Consecuencias

- El orden es de la cuenta, no del dispositivo: el móvil, el ordenador y el acceso rápido lo comparten.
- Un favorito no disponible conserva su sitio: si vuelve (restaurado de la papelera), reaparece donde estaba.
