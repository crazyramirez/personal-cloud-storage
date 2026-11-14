# ADR-0005 — Montaje por UUID con nofail, mountpoint inmutable, servicio independiente del montaje

**Estado:** Aceptado · 2026-11-13 (la línea fstab concreta se fija en S0.2 con datos reales)

## Decisión

- **fstab** por `UUID=`, con un tipo explícito (`exfat`, `ntfs3` o `ntfs-3g`, nunca `ntfs`) y las opciones `rw,nofail,noatime,nodev,nosuid,noexec,uid,gid,fmask=0177,dmask=0077,x-systemd.device-timeout=15s`, más `iocharset=utf8` y `errors=remount-ro` (exFAT) o `windows_names` (NTFS). `pass=0`: sin reparaciones automáticas.
- **Sin `x-systemd.automount`**: un autofs hace que el mountpoint parezca siempre montado y bloquea el acceso cuando falta el disco.
- **Nunca `force`** en NTFS. Si un NTFS sucio o hibernado no monta en rw, se repara con chkdsk en Windows.
- **Mountpoint protegido:** el directorio `/srv/pcloud` de la microSD queda `root:root 0555` + `chattr +i`. Sin disco, ni el servicio ni root pueden crear ficheros ahí por accidente; montar encima sigue funcionando. Script: `deploy/linux/setup/pcloud-mountpoint-guard.sh` (dry-run por defecto).
- **Servicio systemd** (S1.1): `After=` el montaje, **sin** `Requires=`/`RequiresMountsFor=`. La API arranca sin disco y responde 503. El montaje en caliente tras reconectar lo hace el operador (o una unidad udev en S1.7), nunca la aplicación.

## Consecuencias

- Hay que verificar que el montaje se propaga al namespace del servicio con `ProtectSystem=strict` (S1.1); el guardián ya resuelve montajes apilados.
- Deshacer la protección: `sudo chattr -i /srv/pcloud`.
