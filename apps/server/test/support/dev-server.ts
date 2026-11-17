/**
 * Servidor de desarrollo LOCAL: la API real + la web compilada, sobre un volumen temporal y una
 * puerta de volumen falsa. No toca la Raspberry Pi ni ningún disco real. Sirve para probar la
 * interfaz en el ordenador de desarrollo y para simular la desconexión del disco.
 *
 *   pnpm --filter @pcloud/web generate
 *   node apps/server/test/support/dev-server.ts [puerto]
 *
 * Simulación del disco:  GET /__dev/disconnect · /__dev/reconnect · /__dev/readonly
 * Subidas lentas (para ver el progreso): GET /__dev/slow (alterna)
 * Copia de seguridad (discos simulados, sin montar nada real):
 *   /__dev/backup-connect · /__dev/backup-other · /__dev/backup-fat · /__dev/backup-unplug
 *   (el disco de copia simulado es una carpeta temporal; /__dev/slow también ralentiza la copia)
 * Enlaces para compartir: la puerta de invitados se sirve en /s/… de este mismo servidor.
 *   /__dev/funnel-deny (Funnel sin permitir en Tailscale) · /__dev/funnel-allow
 */

import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueSetupToken } from '../../src/auth/sessions.ts';
import type { AgentResult, MountAgent } from '../../src/backup/agent.ts';
import type { DiskLister, ExternalDisk } from '../../src/backup/disks.ts';
import { BackupService } from '../../src/backup/service.ts';
import { buildApp } from '../../src/http/app.ts';
import { ResourceMonitor } from '../../src/system/resources.ts';
import { ShareGateway, type AgentReply, type GatewayAgent } from '../../src/share/gateway.ts';
import { buildGuestApp } from '../../src/share/guest-app.ts';
import { ShareStore } from '../../src/share/store.ts';
import { createHarness } from './harness.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
};
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/.output/public');
const port = Number(process.argv[2] ?? 3999);

const harness = await createHarness();

// Contenido de ejemplo para probar visores, miniaturas y menús.
const iconsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/public/icons');
await mkdir(path.join(harness.dataRoot, 'Fotos', 'Viaje 2026'), { recursive: true });
await mkdir(path.join(harness.dataRoot, 'Documentos'), { recursive: true });
for (const [source, target] of [['icon-512.png', 'Fotos/nube.png'], ['maskable-512.png', 'Fotos/Viaje 2026/playa.png'], ['apple-touch-icon.png', 'Fotos/pequeña.png']]) {
  await copyFile(path.join(iconsDir, source as string), path.join(harness.dataRoot, target as string));
}
const notes = ['# Notas', '', 'Texto de **prueba** con acentos: ñandú, camión.', '', '<script>alert(1)</script> no se ejecuta.', ''];
await writeFile(path.join(harness.dataRoot, 'Documentos', 'notas.md'), notes.join('\n'));
const pdfBody = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
  '4 0 obj<</Length 44>>stream',
  'BT /F1 24 Tf 40 70 Td (Hola PDF) Tj ET',
  'endstream endobj',
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
  '',
].join('\n');
await writeFile(path.join(harness.dataRoot, 'Documentos', 'ejemplo.pdf'), pdfBody);
await writeFile(path.join(harness.dataRoot, 'Documentos', 'informe.docx'), 'no es un docx real');
await writeFile(path.join(harness.dataRoot, 'programa.exe'), 'MZ');
// Copia de seguridad simulada: discos «conectables» y un agente que no monta nada.
const backupDir = path.join(harness.root, '..', `${path.basename(harness.root)}-copia`);
await mkdir(backupDir, { recursive: true });
let simulated: ExternalDisk[] = [];
let mounted = false;
const simDisk = (uuid: string, label: string, fsType = 'exfat'): ExternalDisk => ({
  uuid, device: '/dev/sdb1', fsType, compatible: fsType !== 'vfat', sizeBytes: 2_000_398_934_016, label, model: 'Disco USB simulado', mountpoint: null,
});
const devDisks: DiskLister = { fingerprint: async () => simulated.map((disk) => disk.uuid).join(','), list: async () => simulated };
const devAgent: MountAgent = {
  ready: async () => true,
  request: async (action): Promise<AgentResult> => {
    mounted = action === 'mount';
    return { ok: true, code: action === 'mount' ? 'MOUNTED' : 'UNMOUNTED' };
  },
};
const backup = new BackupService({
  db: harness.db,
  agent: devAgent,
  disks: devDisks,
  mountpoint: backupDir,
  sourceRoot: harness.dataRoot,
  sourceReady: () => harness.gate.state === 'READY' || harness.gate.state === 'READ_ONLY',
  verifyMount: async () => mounted && simulated.length > 0,
  flush: async () => {
    if (slowMs > 0) await new Promise((resolve) => setTimeout(resolve, slowMs));
  },
  log: { info: () => undefined, warn: (o, m) => console.warn(m, o), error: (o, m) => console.error(m, o) },
});
await backup.start(1000);
// En Windows no hay /proc: el monitor usa os.* y deja la temperatura y la alimentación en null.
const resources = new ResourceMonitor();
resources.start();

// Puerta de invitados simulada: «Funnel» responde al instante con la dirección de este servidor.
let funnelAllowed = true;
const devGatewayAgent: GatewayAgent = {
  ready: async () => true,
  request: async (action): Promise<AgentReply> => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (action === 'on' && !funnelAllowed) return { ok: false, code: 'FUNNEL_NOT_ALLOWED', enableUrl: 'https://login.tailscale.com/f/funnel?node=dev123' };
    return { ok: true, code: action === 'on' ? 'ON' : 'OFF', url: action === 'on' ? `http://127.0.0.1:${port}` : undefined };
  },
};
const shareStore = new ShareStore(harness.db);
const gateway = new ShareGateway({ agent: devGatewayAgent, activeCount: () => shareStore.countActive(new Date()), log: { info: () => undefined, warn: () => undefined } });
gateway.start(5000);
const guest = await buildGuestApp({ db: harness.db, store: shareStore, guardian: harness.gate, logger: false, onShareChanged: () => void gateway.reconcile() });
await guest.ready();

// Reinicio y apagado simulados: solo se anotan (el servidor de desarrollo no se reinicia).
const devPower = {
  ready: async () => true,
  request: async (action: 'reboot' | 'poweroff') => {
    console.log(`[dev] ${action} pedido desde la web (simulado)`);
    return { ok: true, code: 'SCHEDULED' };
  },
};

const app = await buildApp({ config: harness.config, db: harness.db, guardian: harness.gate, uploads: harness.uploads({ chunkSize: 1024 * 1024, maxChunkSize: 16 * 1024 * 1024, checkpointBytes: 8 * 1024 * 1024 }), logger: false, backup, resources, shares: { store: shareStore, gateway }, power: devPower, version: 'desarrollo' });
await app.ready();

async function sendFile(response: http.ServerResponse, file: string, status = 200): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    response.writeHead(status, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'content-length': info.size });
    createReadStream(file).pipe(response);
    return true;
  } catch {
    return false;
  }
}

let slowMs = 0;

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    // /__dev/slow: retrasa cada bloque de subida para ver el progreso con calma.
    if (slowMs > 0 && request.method === 'PATCH' && url.pathname.startsWith('/api/v1/uploads/')) {
      setTimeout(() => app.routing(request, response), slowMs);
      return;
    }
    app.routing(request, response);
    return;
  }
  if (url.pathname.startsWith('/s/') || url.pathname === '/robots.txt') {
    guest.routing(request, response);
    return;
  }
  if (url.pathname.startsWith('/__dev/')) {
    const action = url.pathname.slice('/__dev/'.length);
    if (action === 'disconnect') harness.gate.disconnect();
    else if (action === 'reconnect') harness.gate.reconnect();
    else if (action === 'readonly') harness.gate.state = 'READ_ONLY';
    else if (action === 'slow') slowMs = slowMs === 0 ? 1500 : 0;
    else if (action === 'backup-connect') simulated = [simDisk('ABCD-1234', 'COPIA')];
    else if (action === 'backup-other') simulated = [simDisk('FFFF-0000', 'OTRO')];
    else if (action === 'backup-fat') simulated = [simDisk('1111-2222', 'PENDRIVE', 'vfat')];
    else if (action === 'backup-unplug') simulated = [];
    else if (action === 'funnel-deny') funnelAllowed = false;
    else if (action === 'funnel-allow') funnelAllowed = true;
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(`volumen: ${harness.gate.state} (generación ${harness.gate.generation})\n`);
    return;
  }
  const relative = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]|\.\.[/\\])+/, '');
  const target = path.join(publicDir, relative);
  void (async () => {
    if (target.startsWith(publicDir) && ((await sendFile(response, target)) || (await sendFile(response, path.join(target, 'index.html'))))) return;
    if (!(await sendFile(response, path.join(publicDir, '200.html')))) response.writeHead(404).end('Falta la web compilada: pnpm --filter @pcloud/web generate');
  })();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Servidor de desarrollo en http://127.0.0.1:${port}`);
  console.log(`Volumen temporal: ${harness.root}`);
  console.log(`Código de configuración: ${issueSetupToken(harness.db, new Date())}`);
});

const stop = (): void => {
  server.close();
  void app.close().then(() => harness.dispose()).finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
