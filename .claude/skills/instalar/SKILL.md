---
name: instalar
description: Instala, actualiza o repara Personal Cloud Storage en el servidor Linux de la persona (directamente o por SSH), de principio a fin, siguiendo AGENTS.md §2. Úsala cuando pidan instalar, configurar, actualizar o comprobar su nube.
argument-hint: "[usuario@equipo]"
---

Instala Personal Cloud Storage siguiendo **exactamente** la sección 2 de `AGENTS.md` (en la raíz del repositorio) y sus reglas de la sección 1.

Servidor indicado: `$ARGUMENTS` (si está vacío, pregunta si el servidor es este equipo o uno al que se entra por SSH, y cuál).

Orden: 2.1 acceso → 2.2 diagnóstico con `--check` → 2.3 decisiones (disco confirmado por la persona, visores, Tailscale; `sudo`) → 2.4 instalación sin preguntas (en segundo plano con `systemd-run` si dura más que el límite de tus comandos) → 2.5 verificación con `--check` → 2.6 entrega (dirección, código de un solo uso, certificado, aviso de copia de seguridad). Si quiere Tailscale: 2.7, comprobando cada paso de la consola con las claves `tailscale.*` de `--check`.

Antes de cada paso que cambie el servidor, di en una línea qué vas a hacer. Al final, resume qué quedó instalado y qué falta (si falta algo).
