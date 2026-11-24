# ADR-0031: Ver en el navegador lo que se comparte con un enlace

Estado: Aceptado (2026-11-24). Sustituye en parte a [ADR-0018](0018-enlaces-para-invitados.md): la puerta de invitados ya no solo descarga; también muestra imágenes, vídeos, audio y documentos.

## Contexto

Con el ADR-0018, quien recibe un enlace solo puede descargar. Para una foto, un vídeo corto o un PDF eso obliga a bajar el archivo entero y abrirlo con otra app; en el móvil, además, acaba en la carpeta de descargas. El propietario quiere que el invitado lo vea directamente en el navegador, como en la propia app.

La puerta de invitados es lo único publicado en Internet: lo nuevo no puede abrir más superficie de la imprescindible ni romper sus reglas (sin JavaScript, sin pistas, solo lectura, nada fuera de lo compartido).

## Decisión

1. **Visor en la página del enlace.** Un enlace de archivo que se puede ver muestra el archivo en la propia página, con «Descargar» y, en documentos, «Abrir a pantalla completa». En una carpeta, lo que se puede ver abre el visor (`GET /s/<token>/ver?p=…`), con «Anterior», «Siguiente» y «Volver a la carpeta»; un botón aparte descarga. Todo sigue siendo HTML generado en el servidor **sin JavaScript**: `<img>`, `<video>`, `<audio>` e `<iframe>` nativos.
2. **Qué se ve** (decidido solo por el nombre y el tamaño, sin leer el archivo):
   - imágenes que el navegador abre (JPEG, PNG, GIF, WebP, AVIF, BMP, ICO) tal cual, y HEIC, TIFF, RAW… convertidas a JPEG por el servidor (con ffmpeg). **SVG no**: puede llevar código; se descarga;
   - vídeo y audio: el original si el navegador lo entiende y, si no, la conversión al vuelo del servidor. Sin JavaScript, el navegador elige la primera `<source>` que sabe reproducir: el original con su tipo y códecs (también HEVC en Safari o con aceleración) y, después, la versión convertida. La conversión empieza desde el principio (sin JavaScript no se puede pedir otro punto);
   - PDF, documentos de Office convertidos a PDF (LibreOffice, con la caché del disco de datos) y texto de hasta 5 MB, siempre como `text/plain` (HTML o código nunca se interpretan).
3. **Rutas nuevas**, todas con las mismas comprobaciones que la descarga (enlace activo, contraseña, `resolveInside`, StorageGuardian) y, además, que el tipo sea uno de los de arriba para esa ruta; si no, 404: `/v` (original, con `Range` para saltar en el vídeo), `/img` (imagen convertida), `/doc` (Office como PDF) y `/stream` (vídeo o audio convertido).
4. **Aislamiento.** Lo que se ve va `inline`, con `nosniff`, `CSP: sandbox; default-src 'none'` y solo enmarcable por la propia puerta (`frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`). El texto va además en un `<iframe sandbox>`. **Excepción: los PDF** llevan solo `frame-ancestors 'self'`, porque el visor de PDF del navegador no abre en un documento aislado ni con `object-src 'none'`; el JavaScript de un PDF no tiene acceso a la página. La página del visor amplía su CSP solo con `img-src`, `media-src` y `frame-src 'self'`; sigue sin `script-src`.
5. **Ver no es descargar.** Las vistas no cuentan descargas (un vídeo hace decenas de peticiones con `Range`), pero sí suman bytes y último acceso. Cada apertura del visor queda en la auditoría como `share.view`. **Un enlace con límite de descargas no tiene visor**: ver el archivo ya sería tenerlo, así que solo se puede descargar, como antes.
6. **Límites.** Vistas simultáneas: 8 en total, aparte de las 4 descargas (un vídeo abre a veces dos conexiones). Las conversiones usan los límites de la app: 2 reproducciones convertidas a la vez (compartidas con las cuentas de la nube), 1 documento y 2 imágenes. Si están ocupadas, «Hay demasiadas descargas a la vez» (429). Sigue el límite de 240 peticiones por minuto e IP.

## Consecuencias

- El invitado ve fotos, vídeos y documentos sin descargar nada ni instalar apps. En el móvil, el vídeo se reproduce en el navegador.
- Más superficie publicada: cuatro rutas de solo lectura más y las conversiones (ffmpeg, LibreOffice) alcanzables desde Internet mientras haya enlaces activos. Se mitiga con: solo tipos de una lista cerrada, conversiones con concurrencia limitada, la caché del disco de datos (un documento se convierte una vez) y los límites por IP.
- Un invitado que esté viendo un vídeo convertido ocupa una de las 2 conversiones de la app: mientras tanto, el propietario puede encontrarse «ya hay otras reproducciones convertidas en curso».
- En un vídeo convertido no se puede saltar a otro punto (sin JavaScript). El original sí, con `Range`.
- Algunos navegadores móviles (Chrome en Android) no muestran PDF dentro de la página: ahí queda «Abrir a pantalla completa» o «Descargar».

## Alternativas descartadas

- **Reutilizar el visor de la app (Nuxt) en la puerta:** traería JavaScript y la API a la parte pública, justo lo que el ADR-0018 evita.
- **Visor con un poco de JavaScript (por nonce) para saltar en los vídeos convertidos:** rompe la regla «sin JavaScript» por una mejora menor; queda como posible paso futuro.
- **Contar cada vista como descarga:** con `Range` no hay una forma fiable de saber cuándo empieza una vista, y agotaría los enlaces con límite. Por eso los enlaces con límite no tienen visor.
- **Miniaturas en la lista de una carpeta compartida:** cientos de peticiones por página chocan con el límite por IP y cargan la Pi; se deja fuera por ahora.
