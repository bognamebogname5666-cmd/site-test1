import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const days = Number(process.argv[2] || 7);
if (!Number.isInteger(days) || days < 1 || days > 365) { console.error('Укажите период от 1 до 365 дней.'); process.exit(1); }
const path = resolve(projectRoot, process.env.DATABASE_PATH || 'data/bookings.sqlite');
if (!existsSync(path)) { console.log('Заявок пока нет.'); process.exit(0); }
const db = new DatabaseSync(path, { readOnly: true });
try {
  const columns = new Set(db.prepare('PRAGMA table_info(bookings)').all().map(column => column.name));
  const comment = columns.has('comment') ? 'comment' : "'' AS comment";
  const status = columns.has('status') ? 'status' : "'requested' AS status";
  console.table(db.prepare(`SELECT id, name, phone, date, time, guests, ${comment}, created_at, ${status} FROM bookings WHERE datetime(created_at) >= datetime('now', ?) ORDER BY created_at DESC`).all(`-${days} days`));
} finally { db.close(); }
