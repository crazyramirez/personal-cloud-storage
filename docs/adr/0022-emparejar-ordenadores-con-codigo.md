# ADR-0022: Conectar un ordenador a la carpeta de red con un código

Estado: Aceptado (2026-11-17). Sustituye el punto 4 de [ADR-0021](0021-carpeta-de-red-smb.md) en lo
que toca a dónde vive la contraseña.

## Contexto

Con ADR-0021, conectar un ordenador a la carpeta de red exige copiar a mano una dirección, un
usuario y una contraseña de 24 caracteres que el instalador mostraba una sola vez. Es fácil
equivocarse y la mayoría de las personas no es técnica. Se quiere un botón en cada aplicación y un
código corto entre ellas.

## Decisión

1. **La contraseña se guarda en el servidor.** `pcloud-install-smb.sh` la escribe en
   `/etc/pcloud/smb.json` (`root:pcloud 0640`, en la microSD, nunca en el disco de datos). El
   servidor solo la lee. Sin ese fichero, el emparejamiento no está disponible.
2. **Código de un solo uso en la web.** En Ajustes → «Copias de tus ordenadores», el propietario
   pulsa «Conectar un ordenador» y ve un código de 6 cifras.
   - Un solo código vigente: pedir otro anula el anterior.
   - Caduca a los 10 minutos.
   - Se gasta al usarlo.
   - 5 fallos, de cualquier origen, lo anulan. Además hay un límite de 10 intentos por IP cada
     10 minutos.
   - Vive solo en memoria: reiniciar el servidor lo anula.
3. **Canje.** `POST /api/v1/pairing/claim` es público (necesita la cabecera anti-CSRF). Con
   `{code, device}` devuelve la carpeta compartida, el usuario, la contraseña y una carpeta
   propuesta para ese ordenador (el nombre del equipo, saneado). Cada canje, correcto o no, queda en
   la auditoría.
4. **La nube se anuncia en la red.** avahi publica `_pcloud._tcp` (puerto 443, `share=<carpeta>`) y
   `_smb._tcp`. DEV Backup Studio la encuentra con una consulta mDNS, sin que haya que escribir la
   dirección.
5. **En el ordenador**, DEV Backup Studio:
   - Windows: guarda la credencial en el Administrador de credenciales (`CredWriteW`, como
     `cmdkey`, sin que la contraseña pase por la línea de órdenes).
   - macOS: monta el recurso con `osascript`, con el guion por la entrada estándar.
   - Crea la carpeta del ordenador y la pone como destino.

## Consecuencias

- Conectar un ordenador son dos clics y seis cifras.
- **Riesgo aceptado: HTTPS sin comprobar el certificado.** La web usa una CA propia (ADR-0011) que
  el ordenador no conoce, así que la aplicación no comprueba el certificado al canjear.
  - Un atacante dentro de la red de casa que intercepte el tráfico justo en ese momento podría
    quedarse con la contraseña de la carpeta de copias.
  - Esa contraseña no da acceso a la nube ni a la cuenta web: solo a `Copias`, y solo desde la red
    de casa o Tailscale.
  - `pcloud-install-smb.sh --new-password --execute` la cambia. Después hay que volver a conectar
    los ordenadores.
- Todos los ordenadores comparten la misma credencial de Samba. Cada uno escribe en su carpeta por
  convención, no por permisos.

## Alternativas descartadas

- **Un usuario de Samba por ordenador:** crearlo exige root desde la web, es decir, otro agente con
  buzón como el de ADR-0020. Queda para más adelante si hace falta separar ordenadores.
- **Fijar el certificado con la huella en el código:** el código dejaría de ser corto y fácil de
  teclear.
- **Tokens de API y destino HTTP nativo:** ver ADR-0021.
