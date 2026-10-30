import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBookingStore } from './bookings.mjs';

// Local process only: possession of the server/database is the staff boundary.
// There are deliberately no HTTP routes exposing names, phones, or status edits.
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const [id, status, extra] = process.argv.slice(2);
let store;
try {
  if (!/^EZH-[A-F0-9]{8}$/.test(id || '') || !['confirmed', 'cancelled', 'completed'].includes(status) || extra) {
    throw new Error('Укажите идентификатор EZH-XXXXXXXX и статус: confirmed, cancelled или completed.');
  }
  const databasePath = resolve(projectRoot, process.env.DATABASE_PATH || 'data/bookings.sqlite');
  if (!existsSync(databasePath)) throw new Error('Заявок пока нет.');
  store = createBookingStore(databasePath);
  console.log(`${id}: ${store.updateStatus(id, status)}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { store?.close(); }
