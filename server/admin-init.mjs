import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createAdminAuthStore, hashPassword, validPassword, validUsername } from './admin-auth.mjs';

export async function provisionAdmin({ databasePath, username = 'admin', password, reset = false }) {
  if (!validUsername(username)) throw new Error('Имя: 1–64 латинских букв, цифр, точек, дефисов или подчёркиваний.');
  if (!validPassword(password)) throw new Error('Пароль должен содержать от 12 до 128 символов.');
  const hash = await hashPassword(password);
  const store = createAdminAuthStore(databasePath);
  try { store.provision(username, hash, reset); } finally { store.close(); }
  return { username };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const env = resolve(root, '.env');
  if (existsSync(env)) process.loadEnvFile(env);
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const usernameIndex = args.indexOf('--username');
  const username = usernameIndex < 0 ? 'admin' : args[usernameIndex + 1];
  const accepted = args.filter((_, index) => usernameIndex < 0 || (index !== usernameIndex && index !== usernameIndex + 1));
  try {
    if (accepted.some(arg => arg !== '--reset') || (usernameIndex >= 0 && !validUsername(username))) throw new Error('Использование: npm run admin:init -- [--username admin] [--reset]');
    const databasePath = resolve(root, process.env.DATABASE_PATH || 'data/bookings.sqlite');
    const accessPath = resolve(dirname(databasePath), 'admin-access.txt');
    if (existsSync(accessPath) && !reset) throw new Error('Файл доступа уже существует. Для сброса явно укажите --reset.');
    const password = process.env.ADMIN_INITIAL_PASSWORD || randomBytes(24).toString('base64url');
    await provisionAdmin({ databasePath, username, password, reset });
    mkdirSync(dirname(accessPath), { recursive: true });
    writeFileSync(accessPath, `Адрес: http://127.0.0.1:${process.env.PORT || '5173'}/admin/\nЛогин: ${username}\nПароль: ${password}\n\nСмените пароль в панели после первого входа.\n`, { mode: 0o600, flag: reset ? 'w' : 'wx' });
    console.log(accessPath);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
