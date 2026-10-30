import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { request } from 'node:http';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

test('booking API validates, persists, deduplicates, protects data and limits spam', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ezh-test-'));
  const app = await createApp({ databasePath: join(dir, 'test.sqlite'), now: () => new Date('2026-10-20T09:00:00Z'), rateLimit: 4 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const input = { name: 'Анна', phone: '+79991234567', date: '2026-10-21', time: '12:30', guests: 2, consent: true, website: '' };
  const key = 'test-idempotency-key-0001';
  const post = (data, id = key, headers = {}) => fetch(`${base}/api/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': id, ...headers }, body: JSON.stringify(data) });
  try {
    assert.equal((await post({ ...input, phone: 'bad' })).status, 422);
    const first = await post(input);
    assert.equal(first.status, 201);
    const receipt = await first.json();
    assert.match(receipt.id, /^EZH-/);
    assert.equal(receipt.status, 'requested');
    const duplicate = await post(input);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).id, receipt.id);
    assert.equal(app.store.count(), 1);
    assert.equal((await post({ ...input, guests: 3 })).status, 409);
    assert.equal((await post(input, 'cross-origin-key-0001', { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(`${base}/api/bookings`)).status, 405);
    assert.equal((await fetch(`${base}/api/bookings/${receipt.id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/admin/bookings`)).status, 401);
    assert.equal((await fetch(`${base}/data/bookings.sqlite`)).status, 404);
    assert.equal((await post(input, 'new-idempotency-key-0002')).status, 201);
    assert.equal((await post(input, 'new-idempotency-key-0003')).status, 201);
    assert.equal((await post(input, 'new-idempotency-key-0004')).status, 201);
    assert.equal((await post(input, 'new-idempotency-key-0005')).status, 429);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
    await rm(dir, { recursive: true });
  }
});

test('replays a saved request after the booking time eligibility boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ezh-retry-'));
  let clock = new Date('2026-10-20T09:29:59Z');
  const app = await createApp({ databasePath: join(dir, 'test.sqlite'), now: () => clock });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const input = { name: 'Анна', phone: '+79991234567', date: '2026-10-20', time: '13:00', guests: 2, consent: true };
  const post = () => fetch(`${base}/api/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'boundary-key-12345678' }, body: JSON.stringify(input) });
  try {
    const first = await post();
    assert.equal(first.status, 201);
    const id = (await first.json()).id;
    clock = new Date('2026-10-20T09:30:02Z');
    const retry = await post();
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).id, id);
    assert.equal(app.store.count(), 1);
  } finally {
    await new Promise(resolve => app.server.close(resolve)); app.store.close(); await rm(dir, { recursive: true });
  }
});

test('preserves Cyrillic names across UTF-8 HTTP chunk boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ezh-utf8-'));
  const app = await createApp({ databasePath: join(dir, 'test.sqlite'), now: () => new Date('2026-10-20T09:00:00Z') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const input = { name: 'Анна', phone: '+79991234567', date: '2026-10-21', time: '13:00', guests: 2, consent: true };
  const bytes = Buffer.from(JSON.stringify(input));
  const split = bytes.indexOf(Buffer.from('Анна')) + 1;
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'utf8-chunk-key-12345678' };
  try {
    const first = await new Promise((resolve, reject) => {
      const req = request(`${base}/api/bookings`, { method: 'POST', headers }, res => {
        let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('error', reject); req.write(bytes.subarray(0, split)); setTimeout(() => req.end(bytes.subarray(split)), 30);
    });
    assert.equal(first.status, 201);
    const retry = await fetch(`${base}/api/bookings`, { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).id, first.body.id);
  } finally {
    await new Promise(resolve => app.server.close(resolve)); app.store.close(); await rm(dir, { recursive: true });
  }
});

test('development server never serves the database or its sidecar files', async () => {
  const dir = resolve('qa', `private-test-${randomUUID()}`);
  const databasePath = join(dir, 'private.sqlite');
  const app = await createApp({ databasePath, dev: true, hmr: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const relativePath = `/qa/${dir.split(sep).at(-1)}/private.sqlite${suffix}`;
      for (const path of [relativePath, `/@fs/${databasePath.replaceAll('\\', '/')}${suffix}`]) {
        const response = await fetch(base + path);
        assert.ok([403, 404].includes(response.status), `Leaked ${path}: ${response.status}`);
      }
    }
  } finally {
    await new Promise(resolve => app.server.close(resolve)); await app.vite.close(); app.store.close();
    assert.ok(dir.startsWith(resolve('qa') + sep)); await rm(dir, { recursive: true });
  }
});
