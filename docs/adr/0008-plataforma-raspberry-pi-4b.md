# ADR-0008 — Plataforma: Raspberry Pi 4B 8 GB (sustituye a la Orange Pi Zero 2W)

**Estado:** Aceptado · 2026-11-13 · Sustituye a la spec §2

## Contexto

El propietario cambia la placa a una Raspberry Pi 4 Model B. Se anunció como de 4 GB; el inventario real muestra **8 GB** (Rev 1.5). La spec (§16) ya pedía no acoplarse al fabricante, así que el código existente no cambia.

| | Orange Pi Zero 2W (spec) | Raspberry Pi 4B 8 GB (Rev 1.5) |
|---|---|---|
| CPU | 4× Cortex-A53 (H618) | 4× Cortex-A72 (BCM2711), **sin extensiones AES/SHA** |
| USB para el HDD | USB 2.0 (480 Mb/s) | **2× USB 3.0** (controlador VL805 sobre PCIe) |
| Red | Wi-Fi 5 / Ethernet 100 Mb/s por expansión | **Gigabit Ethernet nativo** + Wi-Fi 5 |
| Corriente USB | — | **1,2 A en total** para todos los puertos USB |
| RTC | No | No |
| Detección de subtensión | No | `vcgencmd get_throttled` |

## Decisión

- Placa objetivo: Raspberry Pi 4B; SO **Raspberry Pi OS Lite 64-bit (Debian 13 trixie)**, userland arm64 (verificado).
- El HDD va en un puerto **USB 3.0 (azul)**, en una caja con **alimentación propia** (obligatoria para 3,5"; muy recomendable para 2,5").
- Red por **Ethernet**.
- El sistema sigue en la microSD (spec §3.2); arrancar desde un SSD USB podrá evaluarse con otro ADR.
- La salud de la alimentación (`get_throttled`) y la temperatura entran en el inventario (ya) y en `/system/health` (S1.1).

## Consecuencias

- Los cuellos de botella pasan del bus a la **CPU**: TLS y SHA-256 van por software. Hay que medir el throughput HTTPS real (S0.3) y preferir ChaCha20-Poly1305.
- Los puentes USB-SATA con UAS problemático en la Pi 4 son un riesgo conocido; los quirks se aplican solo con pruebas (resets en el registro del kernel).
- `cmdline.txt` y `config.txt` están en `/boot/firmware/` (verificado en trixie).
- Con 8 GB de RAM hay margen para la caché de metadatos y para Caddy; se prefiere zram al swapfile en la SD.
- Los objetivos de rendimiento de la spec §2 (USB 2.0 / 100 Mb/s) dejan de aplicar; los nuevos se fijan tras medir (S0.3).
