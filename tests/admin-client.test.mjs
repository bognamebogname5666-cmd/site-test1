import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile the actual browser modules without emitting product files or requiring
// extensionless TypeScript imports to work in Node's native ESM resolver.
const dataModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const transpile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const types = dataModule(transpile(await readFile(new URL('../src/admin/types.ts', import.meta.url), 'utf8')));
const source = transpile(await readFile(new URL('../src/admin/api.ts', import.meta.url), 'utf8')).replace("from './types'", `from '${types}'`);
const { AdminApi, ApiError } = await import(dataModule(source));
const session = csrfToken => new Response(JSON.stringify({ username: 'admin', csrfToken }), { headers: { 'Content-Type': 'application/json' } });
const filters = { status: 'all', q: '', dateFrom: '', dateTo: '', page: 1 };
function fastDeadline(t) {
  const nativeTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 12000);
    return nativeTimeout(20);
  });
}
function stalledTransport(_url, options) {
  return new Promise((_resolve, reject) => {
    if (!options.signal) { reject(new Error('Request is missing its deadline signal.')); return; }
    if (options.signal.aborted) { reject(options.signal.reason); return; }
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
}
test('a stalled admin login ends with a recoverable deadline error', async t => {
  fastDeadline(t); t.mock.method(globalThis, 'fetch', stalledTransport);
  // AbortSignal.timeout uses an unref'ed timer; keep this test alive until the
  // observable request failure, rather than depending on the test runner's handles.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(new AdminApi().login('admin', 'synthetic'), error => error instanceof ApiError && error.status === 504); }
  finally { clearTimeout(keepAlive); }
});
test('caller abort cancels an admin list before its request deadline', async t => {
  t.mock.method(globalThis, 'fetch', stalledTransport);
  const controller = new AbortController();
  const promise = new AdminApi().list(filters, controller.signal);
  controller.abort();
  await assert.rejects(promise, error => error.name === 'AbortError');
});
test('an obsolete timed out login cannot replace the current session or CSRF token', async t => {
  fastDeadline(t);
  let call = 0; let logoutCsrf;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    call++;
    if (call === 1) return stalledTransport(url, options);
    if (url.endsWith('/logout')) { logoutCsrf = options.headers['X-CSRF-Token']; return Promise.resolve(new Response('{}')); }
    return Promise.resolve(session('current-session-csrf'));
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const api = new AdminApi();
    const old = assert.rejects(api.login('admin', 'old'), error => error.name === 'AbortError');
    assert.equal((await api.login('admin', 'new')).csrfToken, 'current-session-csrf');
    await old;
    await api.logout();
    assert.equal(logoutCsrf, 'current-session-csrf');
  } finally { clearTimeout(keepAlive); }
});
test('timeout while reading a stalled response body uses the same deadline', async t => {
  fastDeadline(t);
  t.mock.method(globalThis, 'fetch', async (_url, options) => ({
    ok: true, status: 200,
    json: () => stalledTransport('', options)
  }));
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(new AdminApi().login('admin', 'synthetic'), error => error instanceof ApiError && error.status === 504); }
  finally { clearTimeout(keepAlive); }
});
test('ordinary API errors keep their status and message', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ message: 'Слишком много попыток.' }), { status: 429 }));
  await assert.rejects(new AdminApi().login('admin', 'synthetic'), error => error instanceof ApiError && error.status === 429 && error.message === 'Слишком много попыток.');
});
