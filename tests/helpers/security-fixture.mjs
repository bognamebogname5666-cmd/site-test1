import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, copyFile, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from 'node:http';

const source = fileURLToPath(new URL('../../', import.meta.url));
export const secretMarker = 'SYNTHETIC-SECURITY-FIXTURE-NOT-A-REAL-PASSWORD';

// Copy the real server into a disposable project so Vite never loads local .env
// files or exposes the working project's files during hostile-path tests.
export async function securityFixture(t, { dev = true, databaseName = 'private/bookings.bin' } = {}) {
  // Windows CI can expose TEMP through an 8.3 alias such as RUNNER~1.
  // Vite rejects tilde paths; expand the existing parent before creating files.
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'ezh-security-test-'));
  const root = join(directory, 'site');
  let app;
  t.after(async () => {
    if (app) {
      app.server.closeAllConnections();
      await new Promise(resolve => app.server.close(resolve));
      await app.vite?.close(); app.store.close();
    }
    assert.ok(resolve(directory).startsWith(temporaryRoot + sep));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const name of ['server', 'shared', 'src', 'admin', 'public/images', 'dist/admin', 'dist/assets']) await mkdir(join(root, name), { recursive: true });
  for (const name of await readdir(join(source, 'server'))) {
    if (name.endsWith('.mjs')) await copyFile(join(source, 'server', name), join(root, 'server', name));
  }
  for (const name of ['config.json', 'validation.mjs']) await copyFile(join(source, 'shared', name), join(root, 'shared', name));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'vite.config.mjs'), 'export default { envFile: false, server: { watch: null }, logLevel: "silent" };');
  await symlink(join(source, 'node_modules'), join(root, 'node_modules'), 'junction');
  for (const name of ['index.html', 'admin/index.html', 'dist/index.html', 'dist/admin/index.html']) await writeFile(join(root, name), '<!doctype html><title>Safe fixture page</title>');
  await writeFile(join(root, 'src/main.ts'), "import config from '../shared/config.json'; export const cafe: string = config.name;");
  await writeFile(join(root, 'public/images/safe.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await writeFile(join(root, 'dist/assets/safe.js'), 'export const safe = true;');
  const databasePath = join(root, databaseName);
  await mkdir(dirname(databasePath), { recursive: true });
  await writeFile(join(dirname(databasePath), 'admin-access.txt'), secretMarker);
  const { createApp } = await import(pathToFileURL(join(root, 'server/index.mjs')).href);
  app = await createApp({ databasePath, dev, hmr: false, telegram: null });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const get = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
  return { root, databasePath, app, get };
}

export function assertPrivate(response, path) {
  assert.ok([403, 404].includes(response.status), `${path}: expected denial, got ${response.status}`);
  assert.ok(!response.body.includes(Buffer.from(secretMarker)), `${path}: leaked credential marker`);
  assert.ok(!response.body.includes(Buffer.from('SQLite format 3')), `${path}: leaked database`);
}
