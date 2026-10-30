import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApp } from '../../server/index.mjs';
import { validateBooking } from '../../shared/validation.mjs';

const clock = new Date('2026-10-24T09:00:00Z');
const valid = { name: 'Audit Guest', phone: '+79991234567', date: '2026-10-25', time: '12:30', guests: 2, comment: '', consent: true };
const dir = await mkdtemp(join(tmpdir(), 'ezh-public-security-'));
const app = await createApp({ databasePath: join(dir, 'audit.sqlite'), now: () => clock, telegram: null, rateLimit: 2, trustedProxies: [] });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
let sequence = 0;
const post = async (data, options = {}) => {
  const response = await fetch(`${base}/api/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `independent-audit-key-${++sequence}`, ...options.headers },
    body: options.body ?? JSON.stringify(data)
  });
  const body = await response.text();
  return { status: response.status, body, cache: response.headers.get('cache-control') };
};
const results = [];
try {
  for (const bad of [null, [], 3, 'string', { ...valid, name: '<svg/onload=alert(1)>' }, { ...valid, comment: '<img src=x onerror=alert(1)>' }, { ...valid, guests: '2' }, { ...valid, consent: false }, { ...valid, website: 'bot' }]) {
    assert.equal((await post(bad)).status, 422);
  }
  results.push('9 malformed/type/XSS/consent/honeypot requests rejected (422)');
  assert.equal((await post(valid, { body: '{' })).status, 400);
  assert.equal((await post(valid, { body: 'x'.repeat(8193) })).status, 413);
  assert.equal((await post(valid, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  results.push('malformed JSON / oversized body / cross-origin blocked (400/413/403)');
  const sql = { ...valid, name: "Robert'); DROP TABLE bookings;--", comment: "'; UPDATE bookings SET status='confirmed'; --" };
  const key = 'independent-audit-replay-key';
  const first = await post(sql, { headers: { 'Idempotency-Key': key, 'X-Forwarded-For': '192.0.2.1' } });
  assert.equal(first.status, 201);
  assert.equal(first.cache, 'no-store');
  const id = JSON.parse(first.body).id;
  assert.equal(app.store.getBooking(id).name, sql.name);
  assert.equal(app.store.getBooking(id).comment, sql.comment);
  assert.equal(app.store.getBooking(id).status, 'requested');
  assert.equal(app.store.count(), 1);
  results.push('SQL payload persisted literally, table/status intact; response no-store');
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => post(valid, { headers: { 'Idempotency-Key': 'independent-concurrent-audit-key' } })));
  assert.equal(concurrent.filter(result => result.status === 201).length, 1);
  assert.equal(concurrent.filter(result => result.status === 200).length, 11);
  assert.equal(new Set(concurrent.map(result => JSON.parse(result.body).id)).size, 1);
  assert.equal((await post(valid, { headers: { 'X-Forwarded-For': '192.0.2.2' } })).status, 429);
  const replay = await post(sql, { headers: { 'Idempotency-Key': key } });
  assert.equal(replay.status, 200);
  assert.equal(JSON.parse(replay.body).id, id);
  assert.equal((await post({ ...sql, guests: 3 }, { headers: { 'Idempotency-Key': key } })).status, 409);
  assert.equal(app.store.count(), 2);
  results.push('12 concurrent identical submissions created one row; XFF did not bypass limit; replay stable; payload conflict 409');
  for (const path of [`/api/bookings/${id}`, '/api/bookings?all=true', '/api/admin/bookings']) {
    const response = await fetch(base + path);
    const text = await response.text();
    assert.ok([401, 404, 405].includes(response.status));
    assert.ok(!text.includes(sql.name) && !text.includes(valid.phone));
  }
  results.push('public listing/receipt reads unavailable and admin read requires authentication');
  const start = performance.now();
  for (let i = 0; i < 1000; i++) validateBooking(valid, clock);
  results.push(`diagnostic: 1000 bounded validator calls took ${Math.round(performance.now() - start)} ms; no exploit demonstrated`);
  console.log(JSON.stringify({ ok: true, checks: results }, null, 2));
} finally {
  await new Promise(resolve => app.server.close(resolve));
  app.store.close();
  // dir was created by mkdtemp directly under tmpdir; no production paths used.
  assert.ok(dir.startsWith(join(tmpdir(), 'ezh-public-security-')));
  await rm(dir, { recursive: true });
}
