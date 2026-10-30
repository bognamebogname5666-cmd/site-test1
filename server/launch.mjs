import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

async function isReady(url) {
  try {
    const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(1000) });
    const result = await response.json();
    return response.ok && result.service === 'semeyniy-ezh' && result.ready === true;
  } catch { return false; }
}

export async function ensureSiteRunning({ port = Number(process.env.PORT || 5173), host = process.env.HOST || '127.0.0.1', databasePath = process.env.DATABASE_PATH || resolve(projectRoot, 'data/bookings.sqlite') } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть числом от 1 до 65535.');
  const browserHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const url = `http://${browserHost.includes(':') ? `[${browserHost}]` : browserHost}:${port}/`;
  if (await isReady(url)) return { url, started: false };
  if (!existsSync(resolve(projectRoot, 'dist/index.html'))) throw new Error('Нет собранного сайта. Выполните npm ci, затем npm run build.');
  const database = resolve(projectRoot, databasePath);
  const logPath = resolve(dirname(database), 'server.log');
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a');
  let child;
  try {
    child = spawn(process.execPath, [resolve(projectRoot, 'server/index.mjs')], {
      cwd: projectRoot, detached: true, windowsHide: true, stdio: ['ignore', log, log],
      env: { ...process.env, PORT: String(port), HOST: host, DATABASE_PATH: database }
    });
  } finally { closeSync(log); }
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) {
      throw new Error(`Сервер не запустился. Возможно, порт ${port} занят. Подробности: ${logPath}\n${readFileSync(logPath, 'utf8').slice(-1500)}`);
    }
    if (await isReady(url)) return { url, pid: child.pid, started: true };
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (child.pid) child.kill();
  throw new Error(`Сервер не ответил вовремя. Подробности: ${logPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const envPath = resolve(projectRoot, '.env');
    if (existsSync(envPath)) process.loadEnvFile(envPath);
    const result = await ensureSiteRunning();
    console.log(`Сайт готов: ${result.url}`);
    if (!process.argv.includes('--no-browser')) {
      const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', result.url] : [result.url];
      const browser = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' });
      browser.on('error', () => console.log(`Откройте адрес в браузере: ${result.url}`));
      browser.unref();
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
