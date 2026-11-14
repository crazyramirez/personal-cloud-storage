/**
 * admin — administración local de cuentas (ejecutar como el usuario de servicio `pcloud`).
 *
 *   node admin.ts --config /etc/pcloud/config.yaml setup-token        # nuevo código para crear al propietario
 *   node admin.ts --config … user-add <usuario> [--role user|owner]   # la contraseña se lee de stdin
 *   node admin.ts --config … user-del <usuario>
 *   node admin.ts --config … user-list
 *
 * La contraseña nunca se pasa por argumentos (quedaría visible en la lista de procesos).
 */

import path from 'node:path';
import { text } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/passwords.ts';
import { createUser, deleteUser, issueSetupToken, ownerExists } from '../auth/sessions.ts';
import { loadConfig } from '../config/config.ts';
import { openDatabase } from '../db/database.ts';
import { EXIT_USAGE, reportCliError } from './common.ts';

const HELP = 'Uso: node admin.ts --config FICHERO (setup-token | user-add USUARIO [--role user|owner] | user-del USUARIO | user-list)';

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: { config: { type: 'string', short: 'c', default: '/etc/pcloud/config.yaml' }, role: { type: 'string', default: 'user' } },
    allowPositionals: true,
    strict: true,
  });
  const [command, username] = positionals;
  const config = await loadConfig(values.config);
  const db = await openDatabase(path.join(config.paths.stateDir, 'database', 'pcloud.sqlite'), {
    snapshotDir: path.join(config.paths.stateDir, 'snapshots-db'),
  });
  try {
    switch (command) {
      case 'setup-token': {
        if (ownerExists(db)) {
          console.error('Ya existe una cuenta de propietario: no hace falta código de configuración.');
          return 1;
        }
        console.log(issueSetupToken(db, new Date()));
        return 0;
      }
      case 'user-add': {
        if (username === undefined || !/^[A-Za-z0-9._-]{1,64}$/.test(username) || (values.role !== 'user' && values.role !== 'owner')) {
          console.error(HELP);
          return EXIT_USAGE;
        }
        const password = (await text(process.stdin)).replace(/\r?\n$/, '');
        if (password.length < MIN_PASSWORD_LENGTH) {
          console.error(`La contraseña (por stdin) debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
          return EXIT_USAGE;
        }
        createUser(db, username, await hashPassword(password), values.role, new Date());
        console.log(`Usuario ${username} creado (${values.role}).`);
        return 0;
      }
      case 'user-del': {
        if (username === undefined) {
          console.error(HELP);
          return EXIT_USAGE;
        }
        console.log(deleteUser(db, username) ? `Usuario ${username} eliminado.` : `No existe el usuario ${username}.`);
        return 0;
      }
      case 'user-list': {
        for (const row of db.prepare('SELECT username, role, created_at, disabled_at FROM users ORDER BY id').all()) {
          console.log(`${String(row['username'])}\t${String(row['role'])}\t${String(row['created_at'])}${row['disabled_at'] === null ? '' : '\tdesactivado'}`);
        }
        return 0;
      }
      default:
        console.error(HELP);
        return EXIT_USAGE;
    }
  } finally {
    db.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.exitCode = reportCliError(error);
  },
);
