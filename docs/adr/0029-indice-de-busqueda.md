# ADR-0029: Índice de nombres para la búsqueda en carpetas y subcarpetas

Estado: Aceptado (2026-11-24). Matiza la spec §6.1 («sin índice previo»), solo para la búsqueda por nombre.

## Contexto

El cuadro de búsqueda del explorador busca en la carpeta abierta y en todas sus subcarpetas, como en Windows o macOS. La primera versión recorría el disco en cada búsqueda, con un límite de 8 s. En el servidor real (Raspberry Pi 4, HDD USB exFAT), la nube tiene unos 564 000 elementos en 50 000 carpetas y recorrerla entera tarda más de 5 minutos. El coste es del propio núcleo leyendo exFAT: `find` tarda lo mismo. Una búsqueda desde la raíz solo llegaba a ver un 5 % del árbol.

## Decisión

1. **Índice de nombres** en memoria: nombre, carpeta y tipo de cada elemento. Para buscar, los nombres se pliegan (sin mayúsculas ni acentos) y se unen en un solo texto, así que buscar es un `indexOf` nativo: milisegundos con medio millón de nombres.
2. **Lo genera un proceso aparte** (`cli/search-index-scan.ts`) con prioridad baja de CPU (nice 19) y de disco (`ionice -c3` si existe), para no frenar subidas ni la web. Ese proceso solo lee y entrega el índice por la salida estándar; no escribe nada.
3. **Se guarda en la caché del disco de datos** (`.pcloud/cache/search/index-v1.json`), nunca en la microSD. Es regenerable, como las miniaturas. Solo se escribe con el volumen escribible y el mismo lease de principio a fin. Si el disco cambia durante el recorrido, el resultado se descarta. Al arrancar se carga de ahí, así que la búsqueda funciona desde el primer momento.
4. **Renovación:** cada 12 h y unos minutos después de cambios hechos desde la web (como mucho una vez cada 30 min). Lo creado desde la web desde la última vez se recuerda aparte y también se busca.
5. **El índice es solo una pista.** Cada resultado se comprueba en el disco por componentes (sin enlaces, sin salir del volumen) antes de devolverlo. Un índice viejo nunca muestra algo que ya no existe, y una ausencia en el índice nunca se trata como un borrado.
6. **Además, un momento en directo** (1,5 s) por la carpeta de la búsqueda: lo cercano y lo cambiado por la carpeta de red aparece aunque el índice aún no lo tenga. Sin índice todavía, la búsqueda es solo en directo (8 s) y la web avisa de que puede ser parcial.

## Consecuencias

- Buscar en toda la nube cuesta milisegundos en lugar de minutos.
- Lo que cambia fuera de la web (por ejemplo, las copias de DEV Backup Studio por la carpeta de red) puede tardar hasta 12 h en estar en el índice; mientras tanto aparece si está cerca de la carpeta de la búsqueda.
- Memoria: unas decenas de MB por cada medio millón de elementos. Un recorrido completo de vez en cuando, en segundo plano y con prioridad baja.
