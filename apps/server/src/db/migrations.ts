/**
 * Migraciones de esquema, solo hacia delante. Nunca se edita una migración ya publicada:
 * se añade otra. Antes de aplicar migraciones sobre una base existente se guarda una copia
 * (ver database.ts).
 *
 * La base vive en la microSD (/var/lib/pcloud/database), nunca en el HDD exFAT/NTFS (spec §6).
 * Es un índice y un diario: si se pierde, los archivos del HDD siguen intactos.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'usuarios, sesiones, subidas y auditoría',
    sql: `
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('owner', 'user')),
        created_at    TEXT NOT NULL,
        disabled_at   TEXT
      );

      -- id = SHA-256 del token; el token en claro solo existe en la cookie del navegador.
      CREATE TABLE sessions (
        id           TEXT PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ip           TEXT,
        user_agent   TEXT,
        revoked_at   TEXT
      );
      CREATE INDEX sessions_user ON sessions(user_id);

      -- Token de un solo uso para crear la cuenta de propietario (se guarda su SHA-256).
      CREATE TABLE setup_tokens (
        token_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at    TEXT
      );

      -- Subidas reanudables (ADR-0010). confirmed_offset = bytes sincronizados con fsync en el HDD.
      CREATE TABLE uploads (
        id               TEXT PRIMARY KEY,
        user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        dir_path         TEXT NOT NULL,
        name             TEXT NOT NULL,
        size             INTEGER NOT NULL CHECK (size >= 0),
        expected_sha256  TEXT,
        confirmed_offset INTEGER NOT NULL DEFAULT 0,
        state            TEXT NOT NULL CHECK (state IN ('receiving', 'committing', 'completed', 'cancelled', 'failed')),
        final_path       TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        expires_at       TEXT NOT NULL
      );
      CREATE INDEX uploads_state ON uploads(state);

      -- Auditoría básica: nunca contenidos ni contraseñas (spec §6).
      CREATE TABLE audit_log (
        id      INTEGER PRIMARY KEY,
        at      TEXT NOT NULL,
        user_id INTEGER,
        action  TEXT NOT NULL,
        path    TEXT,
        result  TEXT NOT NULL,
        ip      TEXT,
        detail  TEXT
      );
      CREATE INDEX audit_log_at ON audit_log(at);
    `,
  },
  {
    version: 2,
    name: 'llaves de acceso (WebAuthn)',
    sql: `
      -- Identificador opaco del usuario para WebAuthn (no revela el id interno ni el nombre).
      ALTER TABLE users ADD COLUMN webauthn_id TEXT;

      -- Solo la clave PÚBLICA de cada dispositivo; la biometría nunca sale del dispositivo.
      CREATE TABLE passkeys (
        id           TEXT PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key   TEXT NOT NULL,
        algorithm    INTEGER NOT NULL,
        sign_count   INTEGER NOT NULL DEFAULT 0,
        name         TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX passkeys_user ON passkeys(user_id);
    `,
  },
  {
    version: 3,
    name: 'copia de seguridad en disco externo',
    sql: `
      -- Disco asignado como copia (como mucho uno). marker = contenido de .pcloud-backup/backup-id.
      CREATE TABLE backup_disk (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        fs_uuid     TEXT NOT NULL,
        marker      TEXT NOT NULL,
        label       TEXT,
        model       TEXT,
        size_bytes  INTEGER NOT NULL,
        assigned_at TEXT NOT NULL
      );

      CREATE TABLE backup_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE backup_runs (
        id              INTEGER PRIMARY KEY,
        disk_uuid       TEXT NOT NULL,
        started_at      TEXT NOT NULL,
        finished_at     TEXT,
        result          TEXT NOT NULL CHECK (result IN ('running', 'ok', 'ok_with_errors', 'cancelled', 'failed')),
        error           TEXT,
        new_files       INTEGER NOT NULL DEFAULT 0,
        changed_files   INTEGER NOT NULL DEFAULT 0,
        removed_files   INTEGER NOT NULL DEFAULT 0,
        unchanged_files INTEGER NOT NULL DEFAULT 0,
        bytes_to_copy   INTEGER NOT NULL DEFAULT 0,
        bytes_copied    INTEGER NOT NULL DEFAULT 0,
        failed_files    INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];
