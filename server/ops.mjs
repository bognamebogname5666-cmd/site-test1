import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backupDatabase, restoreDatabase, verifyDatabase, purgeBookings } from './ops-database.mjs';
import { probeHealth } from './ops-health.mjs';

const commands = {
  backup: ['database', 'destination'], restore: ['database', 'destination'],
  verify: ['database'], purge: ['database', 'days', 'apply'], health: ['url', 'timeout-ms']
};
export async function runOperations(args) {
  const [command, ...rest] = args;
  if (!Object.hasOwn(commands, command)) throw new Error('Use backup, verify, restore, purge or health with explicit paths/URL.');
  const options = Object.create(null);
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    const name = argument.startsWith('--') ? argument.slice(2) : '';
    if (!commands[command].includes(name) || Object.hasOwn(options, name)) throw new Error('Unknown or duplicate operation option.');
    if (name === 'apply') { options[name] = true; continue; }
    const value = rest[++index];
    if (!value || value.startsWith('--')) throw new Error('An option value is missing.');
    options[name] = value;
  }
  if (command === 'health') {
    if (!options.url) throw new Error('An explicit --url is required.');
    return probeHealth({ url: options.url, ...(options['timeout-ms'] ? { timeoutMs: Number(options['timeout-ms']) } : {}) });
  }
  if (!options.database) throw new Error('An explicit --database path is required; .env is never loaded.');
  if (command === 'verify') return verifyDatabase(options.database);
  if (command === 'purge') return purgeBookings({ databasePath: options.database, apply: options.apply === true, ...(options.days ? { days: Number(options.days) } : {}) });
  if (!options.destination) throw new Error('An explicit --destination to a new file is required.');
  return (command === 'backup' ? backupDatabase : restoreDatabase)({ databasePath: options.database, destination: options.destination });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runOperations(process.argv.slice(2)))); }
  catch (error) {
    // SQLite can contain arbitrary guest text in custom trigger diagnostics.
    // Never print raw database errors or payloads in an operational log.
    console.error(error.code ? `Operation failed (${error.code}). Check the explicit paths, schema and permissions.` : error.message);
    process.exitCode = 1;
  }
}
