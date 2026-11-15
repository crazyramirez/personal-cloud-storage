/**
 * Recursos del equipo (panel): CPU, temperatura, memoria, red, disco del sistema y alimentación.
 */

import { Type, type Static } from 'typebox';

const Bytes = Type.Number();
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()]);

export const ResourcesResponse = Type.Object({
  at: Type.String(),
  cpu: Type.Object({
    /** Uso total (0-100) en los últimos 5 s. */
    percent: Type.Number(),
    /** Uso por núcleo (0-100). */
    cores: Type.Array(Type.Number()),
    /** Carga media de 1, 5 y 15 min. */
    load: Type.Array(Type.Number()),
    mhz: Nullable(Type.Number()),
    maxMhz: Nullable(Type.Number()),
  }),
  /** °C del procesador; null si el equipo no la expone. */
  temperature: Nullable(Type.Number()),
  memory: Type.Object({ totalBytes: Bytes, usedBytes: Bytes, swapTotalBytes: Bytes, swapUsedBytes: Bytes }),
  /** Disco del sistema (tarjeta microSD o SSD de arranque). */
  systemDisk: Nullable(Type.Object({ totalBytes: Bytes, freeBytes: Bytes })),
  network: Type.Object({ rxBytesPerSecond: Type.Number(), txBytesPerSecond: Type.Number() }),
  /** Alimentación y límites de la Raspberry Pi; null en otros equipos. */
  power: Nullable(
    Type.Object({
      undervoltageNow: Type.Boolean(),
      throttledNow: Type.Boolean(),
      heatLimitNow: Type.Boolean(),
      undervoltageSinceBoot: Type.Boolean(),
      throttledSinceBoot: Type.Boolean(),
      heatLimitSinceBoot: Type.Boolean(),
    }),
  ),
  host: Type.Object({ name: Type.String(), model: Nullable(Type.String()), os: Nullable(Type.String()), kernel: Type.String(), node: Type.String() }),
  uptimeSeconds: Type.Number(),
  app: Type.Object({ memoryBytes: Bytes, uptimeSeconds: Type.Number() }),
  /** Últimos 15 min, una muestra cada `intervalSeconds` (instantes en ms). */
  history: Type.Object({
    intervalSeconds: Type.Number(),
    at: Type.Array(Type.Number()),
    cpu: Type.Array(Type.Number()),
    temp: Type.Array(Nullable(Type.Number())),
    mem: Type.Array(Type.Number()),
    rx: Type.Array(Type.Number()),
    tx: Type.Array(Type.Number()),
  }),
});
export type ResourcesResponse = Static<typeof ResourcesResponse>;

/** Respuesta de la prueba de subida: bytes recibidos (el navegador mide el tiempo). */
export const NetTestUploadResponse = Type.Object({ bytes: Type.Number() });
export type NetTestUploadResponse = Static<typeof NetTestUploadResponse>;

/** Prueba de descarga: bytes a enviar (hasta 256 MiB). */
export const NetTestDownloadQuery = Type.Object({ bytes: Type.Integer({ minimum: 1, maximum: 256 * 1024 * 1024 }) }, { additionalProperties: false });
export type NetTestDownloadQuery = Static<typeof NetTestDownloadQuery>;

/** Reiniciar o apagar el equipo (propietario, ADR-0020). */
export const PowerRequest = Type.Object(
  { action: Type.Union([Type.Literal('reboot'), Type.Literal('poweroff')]) },
  { additionalProperties: false },
);
export type PowerRequest = Static<typeof PowerRequest>;

export interface PowerStatusResponse {
  /** El agente de reinicio y apagado está instalado (pcloud-install-power.sh). */
  readonly available: boolean;
}
