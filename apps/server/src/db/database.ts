/**
 * Acceso a SQLite mediante `node:sqlite` (ADR-0002): sin bindings nativos externos.
 * WAL + synchronous=NORMAL: consistente ante un corte y con pocas escrituras en la microSD.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, type Migration } from './migrations.ts';

export type Db = DatabaseSync;

export interface OpenDatabaseOptions {
  /** Directorio para la copia previa a una migración. Sin él no se hace copia (tests en memoria). */
  readonly snapshotDir?: string;
  readonly migrations?: readonly Migration[];
  readonly clock?: () => Date;
}

function appliedVersions(db: Db): Set<number> {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  return new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row['version'])));
}

/** Ejecuta `fn` dentro de una transacción de escritura; revierte si lanza. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function openDatabase(file: string, options: OpenDatabaseOptions = {}): Promise<Db> {
  const migrations = options.migrations ?? MIGRATIONS;
  const clock = options.clock ?? (() => new Date());
  const inMemory = file === ':memory:';
  const existed = !inMemory && existsSync(file);
  if (!inMemory) await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const applied = appliedVersions(db);
  const pending = migrations.filter((migration) => !applied.has(migration.version)).sort((a, b) => a.version - b.version);
  const newest = Math.max(0, ...migrations.map((migration) => migration.version));
  for (const version of applied) {
    if (version > newest) {
      db.close();
      throw new Error(`La base de datos es de una versión más nueva (esquema ${version}) que esta aplicación (${newest})`);
    }
  }

  if (pending.length > 0 && existed && applied.size > 0 && options.snapshotDir !== undefined) {
    await mkdir(options.snapshotDir, { recursive: true, mode: 0o700 });
    const stamp = clock().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const from = Math.max(...applied);
    await backup(db, path.join(options.snapshotDir, `antes-de-migrar-v${from}-${stamp}.sqlite`));
  }

  for (const migration of pending) {
    transaction(db, () => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        clock().toISOString(),
      );
    });
  }
  return db;
}
