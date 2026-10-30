import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dev = process.argv.includes('--dev');
const edgeOnly = process.argv.includes('--edge-only');
const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`QA process exited with ${code}`)));
});

delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
if (!edgeOnly) await run(['--test', 'qa/regressions.mjs'], { QA_BUILT: dev ? '0' : '1' });
const directory = await mkdtemp(join(tmpdir(), 'ezh-ui-qa-data-'));
const output = process.env.QA_OUTPUT || await mkdtemp(join(tmpdir(), 'ezh-ui-qa-evidence-'));
let app;
try {
  app = await createApp({ databasePath: join(directory, 'test.sqlite'), telegram: null, dev, hmr: false, rateLimit: 20 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  await run(['qa/browser.mjs'], { QA_URL: base, QA_OUTPUT: output, QA_DEV: dev ? '1' : '0', QA_EDGE_ONLY: edgeOnly ? '1' : '0' });
  console.log(`QA screenshots and report: ${output}`);
} finally {
  if (app) {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await app.vite?.close();
    app.store.close();
  }
  const target = resolve(directory);
  assert.ok(isAbsolute(target) && target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith('ezh-ui-qa-data-'), 'Only remove the temporary QA database directory');
  await rm(target, { recursive: true, force: true });
}
