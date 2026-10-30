// Isolated Windows HTTP boundary audit. All served files and databases are synthetic.
import { mkdtemp, mkdir, readdir, copyFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from 'node:http';

const source = fileURLToPath(new URL('../../', import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'ezh-http-security-'));
const root = join(temporaryRoot, 'site');
const evidence = [];
let app;
const marker = 'SYNTHETIC-SECRET-HTTP-AUDIT';
const get = (port, path, headers = {}, method = 'GET', body) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'], body: Buffer.concat(chunks) }));
  });
  req.on('error', reject); req.end(body);
});
async function probe(mode, port, path, headers = {}, method = 'GET', body) {
  try {
    const result = await get(port, path, headers, method, body);
    evidence.push({ mode, path, method, host: headers.Host, status: result.status, bytes: result.body.length, syntheticSecret: result.body.includes(Buffer.from(marker)), sqlite: result.body.subarray(0, 15).toString() === 'SQLite format 3' });
  } catch (error) { evidence.push({ mode, path, error: error.message }); }
}
async function stop() {
  if (!app) return;
  await new Promise(resolve => app.server.close(resolve));
  await app.vite?.close(); app.store.close(); app = null;
}
try {
  for (const dir of ['server', 'shared', 'dist', 'data', 'private']) await mkdir(join(root, dir), { recursive: true });
  for (const name of await readdir(join(source, 'server'))) {
    if (name.endsWith('.mjs')) await copyFile(join(source, 'server', name), join(root, 'server', name));
  }
  for (const name of ['validation.mjs', 'config.json']) await copyFile(join(source, 'shared', name), join(root, 'shared', name));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'vite.config.mjs'), 'export default { envFile: false, server: { watch: null }, logLevel: "silent" };');
  await symlink(join(source, 'node_modules'), join(root, 'node_modules'), 'junction');
  await writeFile(join(root, 'dist', 'index.html'), '<!doctype html><title>Synthetic site</title>');
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Synthetic dev site</title>');
  for (const dir of ['data', 'private']) {
    await writeFile(join(root, dir, 'admin-access.txt'), marker);
    await writeFile(join(root, dir, '.env'), marker);
  }
  const { createApp } = await import(pathToFileURL(join(root, 'server', 'index.mjs')));
  for (const fixture of [{ mode: 'dev-default', dev: true, database: 'data/bookings.sqlite' }, { mode: 'dev-custom', dev: true, database: 'private/bookings.sqlite' }, { mode: 'production', dev: false, database: 'data/bookings.sqlite' }]) {
    app = await createApp({ databasePath: join(root, fixture.database), dev: fixture.dev, hmr: false, telegram: null });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const port = app.server.address().port;
    const directory = fixture.mode === 'dev-custom' ? 'private' : 'data';
    for (const path of [`/${directory}/admin-access.txt`, `/${directory}%5cadmin-access.txt`, `/${directory}/admin-access.txt.`, `/${directory}./admin-access.txt`, `/${directory}./admin-access.txt.`, `/${directory}%20/admin-access.txt.`, `/${directory}/admin-access.txt::$DATA`, `/${directory}./bookings.sqlite.`, `/${directory}./.env.`, `/${directory}/.env.`, '/server/index.mjs', '/.%5c..%5cserver/index.mjs', '/%00']) await probe(fixture.mode, port, path);
    await probe(fixture.mode, port, '/', { Host: 'attacker.example' });
    await probe(fixture.mode, port, '/api/health', { Host: 'attacker.example' });
    await probe(fixture.mode, port, '/api/bookings', { Host: 'attacker.example', Origin: 'http://attacker.example', 'Content-Type': 'application/json', 'Idempotency-Key': 'synthetic-rebinding-1234' }, 'POST', JSON.stringify({ name: 'Audit', phone: '+79991234567', date: '2026-10-25', time: '12:30', guests: 2, consent: true }));
    await stop();
  }
  console.log(JSON.stringify({ runtime: process.version, platform: process.platform, evidence }, null, 2));
} finally {
  await stop();
  if (!resolve(temporaryRoot).startsWith(resolve(tmpdir()))) throw new Error('Unsafe cleanup target');
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
