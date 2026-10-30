import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { request } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createApp } from '../server/index.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-static-'));
  const app = await createApp({ databasePath: join(directory, 'test.sqlite'), telegram: null, trustedProxies: [], ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve)); app.store.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const get = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: app.server.address().port, path, headers, method }, res => {
      const chunks = []; res.on('data', data => chunks.push(data));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  return { get };
}

test('static HTML negotiates Brotli and gzip without changing its content', async t => {
  const { get } = await fixture(t);
  const original = await get('/', { 'Accept-Encoding': 'identity' });
  for (const [encoding, decode] of [['br', brotliDecompressSync], ['gzip', gunzipSync]]) {
    const encoded = await get('/', { 'Accept-Encoding': encoding });
    assert.equal(encoded.headers['content-encoding'], encoding);
    assert.deepEqual(decode(encoded.body), original.body);
    assert.ok(encoded.body.length < original.body.length / 2);
    assert.match(encoded.headers.vary, /Accept-Encoding/i);
    assert.equal(Number(encoded.headers['content-length']), encoded.body.length);
  }
  assert.equal((await get('/', { 'Accept-Encoding': 'br;q=0, gzip;q=0' })).headers['content-encoding'], undefined);
  assert.equal((await get('/', { 'Accept-Encoding': 'br;q=.5, gzip;q=1' })).headers['content-encoding'], 'gzip');
  assert.equal((await get('/', { 'Accept-Encoding': '*;q=0' })).status, 406);
});

test('explicit HTTPS configuration advertises host-only HSTS on every response', async t => {
  const secure = await fixture(t, { adminCookieSecure: true });
  for (const path of ['/', '/admin/', '/api/health', '/missing-hsts-page', '/api/admin/bookings']) {
    const response = await secure.get(path);
    assert.equal(response.headers['strict-transport-security'], 'max-age=31536000', path);
  }
  const local = await fixture(t, { adminCookieSecure: false });
  const response = await local.get('/', { 'X-Forwarded-Proto': 'https' });
  assert.equal(response.headers['strict-transport-security'], undefined, 'Untrusted forwarding cannot enable HSTS');
});

test('unchanged resources revalidate with ETag and Last-Modified while private API stays uncached', async t => {
  const { get } = await fixture(t);
  const first = await get('/images/hedgehog.svg');
  assert.ok(first.headers.etag);
  assert.ok(first.headers['last-modified']);
  const unchanged = await get('/images/hedgehog.svg', { 'If-None-Match': first.headers.etag });
  assert.equal(unchanged.status, 304); assert.equal(unchanged.body.length, 0);
  assert.equal((await get('/images/hedgehog.svg', { 'If-Modified-Since': first.headers['last-modified'] })).status, 304);
  assert.equal((await get('/images/hedgehog.svg', { 'If-None-Match': '"changed"', 'If-Modified-Since': first.headers['last-modified'] })).status, 200);
  const head = await get('/images/hedgehog.svg', {}, 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(head.headers.etag, first.headers.etag);
  const privateResponse = await get('/api/admin/bookings');
  assert.equal(privateResponse.status, 401); assert.equal(privateResponse.headers['cache-control'], 'no-store');
  assert.equal(privateResponse.headers.etag, undefined);
});

test('public canonical aliases redirect permanently and preserve the query', async t => {
  const { get } = await fixture(t);
  const html = (await get('/')).body.toString();
  assert.match(html, /<link\s+rel="canonical"\s+href="\/"/);
  for (const [path, target] of [['/index.html?from=audit', '/?from=audit'], ['/admin?from=audit', '/admin/?from=audit'], ['/admin/index.html', '/admin/']]) {
    const res = await get(path);
    assert.ok([301, 308].includes(res.status)); assert.equal(res.headers.location, target);
  }
  assert.equal((await get('/admin/')).status, 200);
});

test('missing pages return a useful Russian HTML page with a genuine 404 code', async t => {
  const { get } = await fixture(t);
  for (const path of ['/missing/audit-page', '/404.html']) {
    const res = await get(path);
    assert.equal(res.status, 404);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.match(res.body.toString(), /Страница не найдена/);
    assert.match(res.body.toString(), /href="\/"/);
    assert.match(res.body.toString(), /noindex/);
  }
});
