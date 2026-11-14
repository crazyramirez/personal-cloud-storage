# Descubrimiento de hardware

La §2 sirve para cualquier servidor; en otro hardware omite lo específico de Raspberry Pi (EEPROM, `get_throttled`). La §3 recoge los resultados del hardware de referencia (Raspberry Pi 4B).

Fase 0. Hay que rellenar este documento con **resultados reales** antes de escribir `/etc/fstab` o cualquier script de montaje (spec §2, §17.2).

## 1. Cómo obtener los datos

Todos los scripts son de **solo lectura**. Copia la carpeta `deploy/linux/` al servidor (por ejemplo con `scp -r deploy/linux pi@<ip>:~/pcloud-diag`) y ejecuta:

```bash
cd ~/pcloud-diag
sudo bash diagnostics/pcloud-inventory.sh > inventario.md
sudo bash diagnostics/pcloud-volume-check.sh --list
sudo bash diagnostics/pcloud-volume-check.sh --uuid <UUID-del-HDD> > volumen.md
bash setup/pcloud-mountpoint-guard.sh check
# Solo si el HDD ya está montado en algún sitio y tiene datos:
bash diagnostics/pcloud-name-audit.sh /ruta/montaje --summary
```

Revisa los informes antes de compartirlos: pueden contener números de serie, MACs e IPs. `inventario*.md` y `volumen*.md` están en `.gitignore`.

## 2. Datos que hay que verificar

| # | Dato | Dónde sale | Por qué importa | Valor |
|---|---|---|---|---|
| H1 | Modelo y revisión de la placa | inventario §1 | Revisiones antiguas a 1,5 GHz; límites de USB | |
| H2 | RAM | inventario §2 | Dimensionar caché y concurrencia | ver §3 |
| H3 | Distribución y versión | inventario §1 | Paquetes, kernel, soporte | |
| H4 | Kernel (`uname -r`) | inventario §1 | exfat/ntfs3/windows_names | |
| H5 | **Arquitectura del userland** (`dpkg --print-architecture`) | inventario §1 | **Debe ser `arm64` o `amd64`**: Node 26 no tiene build de 32 bits | |
| H6 | Versión del bootloader (EEPROM) | inventario §1 | Correcciones de USB y arranque | |
| H7 | `get_throttled` en reposo y tras 1 h de carga | inventario §2 | Subtensión = riesgo directo para el HDD | |
| H8 | Temperatura en reposo y en carga | inventario §2 | Throttling | |
| H9 | Extensiones criptográficas de la CPU | inventario §2 | Se esperan ausentes (BCM2711): TLS/SHA por software | |
| H10 | Módulos `exfat` / `ntfs3` y `CONFIG_*` | inventario §3 | Controlador viable | |
| H11 | Herramientas `exfatprogs`, `ntfs-3g`, `smartmontools` | inventario §3 | Comprobaciones de solo lectura | |
| H12 | Helpers `mount.exfat*` / `mount.ntfs*` | inventario §3 | Pueden secuestrar el tipo de montaje | |
| H13 | Puerto usado (USB 3.0 azul) y velocidad (`5000M`) | inventario §4 `lsusb -t` | Rendimiento | |
| H14 | Driver `uas` o `usb-storage`, **VID:PID del puente** | inventario §4 | Quirks UAS (R2) | |
| H15 | Resets USB / errores de E/S en el registro del kernel | inventario §9 | Estabilidad | |
| H16 | HDD: modelo, 2,5"/3,5", alimentación | inventario §5 + física | R1 | |
| H17 | Tabla de particiones y nº de particiones | volumen | Identificar la de datos | |
| H18 | **FSTYPE, UUID, LABEL** | volumen | fstab por UUID, config | |
| H19 | Tamaño de clúster (exFAT) | volumen | Desperdicio con ficheros pequeños | |
| H20 | Flags VolumeDirty/MediaFailure (exFAT) o dirty (NTFS) | volumen | No montar en rw si está sucio | |
| H21 | ¿Datos existentes? Espacio usado, carpetas raíz | volumen | Opción de onboarding a/b/c | |
| H22 | Nombres incompatibles (resumen del name-audit) | name-audit | Política de importación | |
| H23 | ¿SMART disponible a través del puente? | inventario `--smart` | Salud real o "no disponible" | |
| H24 | Ethernet: velocidad de enlace (1000) | inventario §7 | Rendimiento | |
| H25 | Throughput de red real (`iperf3`) | manual | Objetivos de transferencia | |
| H26 | NTP sincronizado | inventario §7 | Sin RTC (R6) | |
| H27 | microSD: modelo y capacidad; tipo de swap | inventario §2, §5 | Desgaste (R5) | |
| H28 | udisks2 activo / imagen con escritorio | inventario §5 | Automontaje (R8) | |
| H29 | Puertos a la escucha | inventario §7 | Superficie expuesta | |
| H30 | ¿Existe ya el usuario `pcloud`? | inventario §8 | uid/gid del fstab | |

## 3. Resultados (inventario del 2026-11-13, HDD aún sin conectar)

| # | Resultado | Valoración |
|---|---|---|
| H1 | Raspberry Pi 4 Model B **Rev 1.5**, Cortex-A72 a 1,8 GHz | ✅ |
| H2 | **8 GB** (7,6 GiB visibles), no 4 GB | ✅ margen amplio |
| H3 | Raspberry Pi OS Lite 64-bit, Debian **13.7 trixie**, systemd 257 | ✅ |
| H4 | `6.18.50+rpt-rpi-v8` en el inventario; tras la actualización de S0.2, **`6.18.60+rpt-rpi-v8`** | ✅ exfat y ntfs3 modernos |
| H5 | userland **arm64**, kernel aarch64 | ✅ compatible con Node 26 |
| H6 | Bootloader 2026-09-23 y VL805 `000138c0`; tras la actualización hay EEPROM 2026-10-30 disponible (sin aplicar) | ✅ |
| H7 | `throttled=0x0` en reposo | ✅ (falta la prueba con carga y HDD, S0.3) |
| H8 | 38 °C en reposo | ✅ |
| H9 | `fp asimd evtstrm crc32 cpuid`: **sin AES/SHA** | ⚠️ confirma R7: TLS y SHA-256 por software |
| H10 | `exfat=m`, `ntfs3=m`, `EXFAT_DEFAULT_IOCHARSET="utf8"`, sin el `ntfs` legado | ✅ |
| H11 | exfatprogs 1.2.9, ntfs-3g 2022.10.3; smartmontools, hdparm, iperf3 y fio instalados en S0.2 | ✅ |
| H12 | `mount.ntfs → ntfs-3g` (confirma C6); sin `mount.exfat` (no hay exfat-fuse) | ✅ con `-t exfat` se usa el kernel |
| H13 | Puerto USB 3.0, enlace a **5000M** | ✅ |
| H14 | Puente WD `1058:2626` (My Passport, nativo USB), driver **`usb-storage`** (BOT, no UAS); admite UNMAP (granularidad 4K, máximo 4G); sin página de caché SCSI | ✅ estable; caché resuelta con [ADR-0009](adr/0009-durabilidad-cache-y-directorios.md) |
| H15 | Sin errores USB en uso normal | ✅ |
| H16 | **WDC WD50NDZW-11BCSS0**, 5 TB, 2,5", 4800 rpm, **SMR**, alimentado por el USB de la Pi (bMaxPower 896 mA) | ✅ `throttled=0x0` en arranque del motor y escrituras sostenidas |
| H17 | GPT, 1 partición (offset 1 MiB, tipo Microsoft basic data) | ✅ |
| H18 | **exFAT, etiqueta `PCLOUD`, UUID `1A2B-3C4D`** (formateado el 2026-11-13; de fábrica era NTFS "My Passport") | ✅ |
| H19 | Clúster de **32 KiB** (decisión del propietario: contenido mixto) | ✅ |
| H20 | Limpio tras formatear; VolumeDirty limpiado tras las pruebas F0 (`fsck.exfat -p`, autorizado) | ✅ |
| H21 | Disco **nuevo** (SMART: 0 h, 3 ciclos), sin datos: solo traía 2 instaladores de WD (1,3 MB) | ✅ opción de onboarding (a) "empezar vacío" |
| H22 | No aplica (disco vacío) | — |
| H23 | SMART disponible a través del puente: **PASSED**, 0 sectores realocados o pendientes, APM 254, caché de escritura activa | ✅ |
| H24 | **Ethernet sin cable** (`eth0` DOWN). Wi-Fi 5 GHz, canal 40/80 MHz, −46 dBm, enlace 433 Mb/s | ⚠️ conectar Ethernet (D3) |
| H25 | — | ⏳ iperf3 (S0.3) |
| H26 | NTP sincronizado (systemd-timesyncd) | ✅ |
| H27 | microSD SanDisk 64 GB (SN64G, 09/2026). Swap: zram 2 GB zstd con writeback a `/var/swap` | ✅ con 8 GB apenas se escribe en la SD |
| H28 | udisks2 bajo demanda, sin agente de automontaje; `/media` vacío | ✅ |
| H29 | Solo `sshd:22` y `avahi:5353` a la escucha | ✅ |
| H30 | Usuario `pcloud` creado en S0.2 | ✅ |

### Otros hallazgos

- journald con `Storage=volatile` (logs en RAM): protege la SD, pero se pierden al reiniciar. Se mantiene; se revisa en S1.7.
- `/tmp` en tmpfs.
- `cgroup_disable=memory` lo añade el firmware: `MemoryMax=` de systemd no tendrá efecto hasta añadir `cgroup_enable=memory` a `cmdline.txt` (S1.1).
- El ahorro de energía del Wi-Fi estaba **activado**; se desactivó en S0.2.
- `rpi-connect-lite` está instalado pero desactivado (sin acceso remoto por la nube de Raspberry Pi).
- SSH con contraseña y sin claves de fábrica: se endurece con `pcloud-ssh-hardening.sh` (R17).

### Decisiones derivadas

- Sistema de archivos: **exFAT con el controlador del kernel**, clúster de 32 KiB. El disco venía con NTFS de fábrica casi vacío y el propietario autorizó formatearlo. En Linux, NTFS no protege con su diario las escrituras (ntfs3 solo lo reproduce), así que no aportaba seguridad.
- Línea fstab definitiva: ver [OPERATIONS §1](OPERATIONS.md#1-qué-se-instala-y-dónde).
- Quirks USB: ninguno necesario (puente estable con `usb-storage`).
- **Caché de escritura:** el kernel la creía *write through*; regla udev para que `fsync` la vacíe ([ADR-0009](adr/0009-durabilidad-cache-y-directorios.md)).
- Alimentación del HDD: por el USB de la Pi con la fuente oficial; sin subtensión medida. Si alguna vez aparece un bit de subtensión → hub alimentado o cable en Y.
- Rendimiento a tener en cuenta: disco **SMR** (las escrituras sostenidas largas pueden ralentizarse cuando se llena su caché interna) y un `fsync` real cuesta ~60 ms.
