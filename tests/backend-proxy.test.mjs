import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';

const input = { name: 'Анна', phone: '+79991234567', date: '2026-10-21', time: '12:30', guests: 2, consent: true };

async function withApp(options, run) {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-proxy-'));
  const app = await createApp({ databasePath: join(directory, 'test.sqlite'), now: () => new Date('2026-10-20T09:00:00Z'), rateLimit: 1, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let sequence = 0;
  const post = forwardedFor => fetch(`http://127.0.0.1:${app.server.address().port}/api/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `proxy-request-key-${++sequence}`, ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}) },
    body: JSON.stringify(input)
  });
  try { await run(post, app); }
  finally {
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
    await rm(directory, { recursive: true });
  }
}

test('trusted reverse proxy gives different customers independent booking limits', () => withApp({ trustedProxies: ['127.0.0.1'] }, async post => {
  assert.equal((await post('192.0.2.1')).status, 201);
  assert.equal((await post('192.0.2.2')).status, 201);
  assert.equal((await post('192.0.2.1')).status, 429);
}));

test('untrusted clients cannot bypass a booking limit by spoofing forwarded addresses', () => withApp({ trustedProxies: [] }, async post => {
  assert.equal((await post('192.0.2.1')).status, 201);
  assert.equal((await post('192.0.2.2')).status, 429);
}));

test('proxy chain stops at the nearest untrusted hop and ignores attacker supplied prefixes', () => withApp({ trustedProxies: ['127.0.0.1', '10.0.0.1'] }, async post => {
  assert.equal((await post('203.0.113.8, 192.0.2.1, 10.0.0.1')).status, 201);
  assert.equal((await post('203.0.113.9, 192.0.2.1, 10.0.0.1')).status, 429);
  assert.equal((await post('203.0.113.8, 192.0.2.2, 10.0.0.1')).status, 201);
}));

test('malformed forwarding headers fall back to the socket address', () => withApp({ trustedProxies: ['127.0.0.1'] }, async post => {
  assert.equal((await post('not-an-ip')).status, 201);
  assert.equal((await post('192.0.2.2:1234')).status, 429);
  assert.equal((await post('192.0.2.2,,10.0.0.1')).status, 429);
}));

test('IPv4-mapped proxy allowlist and equivalent IPv6 clients use canonical addresses', () => withApp({ trustedProxies: ['::ffff:127.0.0.1'] }, async post => {
  assert.equal((await post('2001:db8::1')).status, 201);
  assert.equal((await post('2001:0db8:0000:0000:0000:0000:0000:0001')).status, 429);
  assert.equal((await post('2001:db8::2')).status, 201);
}));

test('invalid trusted proxy configuration fails before creating a database', async () => {
  for (const trustedProxies of [['*'], ['10.0.0.0/8'], ['localhost'], ['127.0.0.1', 'bad']]) {
    await assert.rejects(createApp({ databasePath: ':memory:', trustedProxies }), /TRUSTED_PROXIES|trustedProxies/);
  }
});
