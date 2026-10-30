import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/index.mjs';

const password = 'Secure-password-12345';
const booking = { name: 'Анна', phone: '+79991234567', date: '2026-10-25', time: '12:30', guests: 2, comment: '<script>alert(1)</script>', consent: true };
async function fixture(t, { provision = true, ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-admin-'));
  const databasePath = join(directory, 'bookings.sqlite');
  if (provision) {
    const { provisionAdmin } = await import('../server/admin-init.mjs');
    await provisionAdmin({ databasePath, username: 'admin', password });
  }
  let current = new Date('2026-10-23T09:00:00Z');
  const app = await createApp({ databasePath, now: () => current, telegram: null, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); await rm(directory, { recursive: true, force: true }); });
  let cookie = ''; let csrfToken = '';
  const request = async (path, { method = 'GET', data, headers = {}, auth = true, origin = base } = {}) => {
    const result = await fetch(base + '/api/admin' + path, { method, headers: {
      ...(auth && cookie ? { Cookie: cookie, 'X-CSRF-Token': csrfToken } : {}),
      ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers
    }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    return result;
  };
  const login = async () => {
    const response = await request('/login', { method: 'POST', data: { username: 'admin', password }, auth: false });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0];
    csrfToken = (await response.json()).csrfToken;
    return { cookie, csrfToken, response };
  };
  return { app, base, request, login, databasePath, directory, setTime: value => { current = new Date(value); } };
}

test('admin endpoints deny unauthenticated reads and mutations without provisioning a default account', async t => {
  const { request } = await fixture(t, { provision: false });
  assert.equal((await request('/session')).status, 401);
  assert.equal((await request('/bookings')).status, 401);
  assert.equal((await request('/bookings/EZH-12345678', { method: 'PATCH', data: { status: 'confirmed' } })).status, 401);
  assert.equal((await request('/login', { method: 'POST', data: { username: 'admin', password } })).status, 401);
});

test('login sets a private bounded cookie and persists only password and session hashes', async t => {
  const { login, request, databasePath } = await fixture(t);
  const { cookie, csrfToken, response } = await login();
  assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(response.headers.get('set-cookie'), /SameSite=Strict/i);
  assert.match(response.headers.get('set-cookie'), /Path=\/api\/admin/);
  assert.match(response.headers.get('set-cookie'), /Max-Age=28800/);
  assert.match(csrfToken, /^[a-zA-Z0-9_-]{32,}$/);
  assert.deepEqual(await (await request('/session')).json(), { username: 'admin', csrfToken });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const users = database.prepare('SELECT * FROM admin_users').all();
  const sessions = database.prepare('SELECT * FROM admin_sessions').all();
  assert.equal(users.length, 1); assert.equal(sessions.length, 1);
  assert.ok(!JSON.stringify(users).includes(password));
  assert.ok(!JSON.stringify(sessions).includes(cookie.split('=')[1]));
  database.close();
});

test('admin writes require the exact Origin, JSON and CSRF token', async t => {
  const { request, login } = await fixture(t);
  await login();
  for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:1', 'http://user@127.0.0.1']) {
    assert.equal((await request('/logout', { method: 'POST', data: {}, origin })).status, 403);
  }
  assert.equal((await request('/logout', { method: 'POST', data: {}, headers: { Origin: '' } })).status, 403);
  assert.equal((await request('/logout', { method: 'POST', data: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/logout', { method: 'POST', data: {}, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await request('/session')).status, 200);
});

test('logout revokes the persisted session and clears its cookie', async t => {
  const { request, login } = await fixture(t); await login();
  const response = await request('/logout', { method: 'POST', data: {} });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/session')).status, 401);
});

test('sessions expire after eight hours and do not trust forwarded protocol for cookie security', async t => {
  const { request, login, setTime } = await fixture(t);
  const { response } = await login(); assert.doesNotMatch(response.headers.get('set-cookie'), /; Secure/i);
  setTime('2026-10-23T17:00:00Z'); assert.equal((await request('/session')).status, 401);
  const again = await request('/login', { method: 'POST', data: { username: 'admin', password }, headers: { 'X-Forwarded-Proto': 'https' } });
  assert.doesNotMatch(again.headers.get('set-cookie'), /; Secure/i);
});

test('list filters and pagination preserve global counts and literal search text', async t => {
  const { app, login, request } = await fixture(t); await login();
  const id = app.store.save(booking, 'admin-booking-0001', new Date('2026-10-23T09:00:00Z'));
  const second = app.store.save({ ...booking, name: 'Борис', date: '2026-10-26' }, 'admin-booking-0002', new Date('2026-10-23T10:00:00Z'));
  app.store.updateStatus(second, 'confirmed');
  const response = await request('/bookings?status=requested&q=' + encodeURIComponent('Анна') + '&dateFrom=2026-10-25&dateTo=2026-10-25&pageSize=1');
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.total, 1); assert.equal(result.page, 1); assert.equal(result.pageSize, 1);
  assert.equal(result.items[0].id, id); assert.equal(result.items[0].comment, booking.comment);
  assert.deepEqual(result.counts, { requested: 1, confirmed: 1, cancelled: 0, completed: 0 });
  assert.equal((await (await request('/bookings?q=%25')).json()).total, 0);
  for (const query of ['status=unknown', 'q=' + 'x'.repeat(101), 'dateFrom=2026-02-30', 'dateFrom=2026-10-26&dateTo=2026-10-25', 'page=0', 'pageSize=101', 'page=1.5']) {
    assert.equal((await request('/bookings?' + query)).status, 400, query);
  }
});

test('optimistic status changes are atomic, validate transitions and record actor history', async t => {
  const { app, login, request } = await fixture(t); await login();
  const id = app.store.save(booking, 'admin-status-0001', new Date());
  const patch = data => request('/bookings/' + id, { method: 'PATCH', data });
  assert.equal((await patch({ status: 'confirmed', expectedStatus: 'requested' })).status, 200);
  assert.equal((await patch({ status: 'cancelled', expectedStatus: 'requested' })).status, 409);
  assert.equal((await patch({ status: 'requested', expectedStatus: 'confirmed' })).status, 409);
  assert.equal((await patch({ status: 'fake', expectedStatus: 'confirmed' })).status, 400);
  assert.equal((await patch({ status: 'completed' })).status, 400);
  assert.equal((await patch({ status: 'completed', expectedStatus: 'confirmed' })).status, 200);
  assert.equal((await patch({ status: 'cancelled', expectedStatus: 'completed' })).status, 409);
  const detail = await (await request('/bookings/' + id)).json();
  assert.equal(detail.booking.status, 'completed'); assert.equal(detail.history.length, 2);
  assert.equal(detail.history[0].actor, 'admin'); assert.equal(detail.history[0].fromStatus, 'requested'); assert.equal(detail.history[0].toStatus, 'confirmed');
  assert.equal((await request('/bookings/EZH-00000000', { method: 'PATCH', data: { status: 'confirmed', expectedStatus: 'requested' } })).status, 404);
});

test('password changes require the current password and revoke every session', async t => {
  const { request, login } = await fixture(t); const first = await login(); await login();
  const change = data => request('/password', { method: 'POST', data });
  assert.equal((await change({ currentPassword: 'wrong', newPassword: 'Another-secure-67890' })).status, 400);
  assert.equal((await request('/session')).status, 200);
  assert.equal((await change({ currentPassword: password, newPassword: 'short' })).status, 400);
  const response = await change({ currentPassword: password, newPassword: 'Another-secure-67890' });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/session')).status, 401);
  assert.equal((await request('/session', { headers: { Cookie: first.cookie } })).status, 401);
  assert.equal((await request('/login', { method: 'POST', data: { username: 'admin', password: 'Another-secure-67890' } })).status, 200);
});

test('concurrent failed logins cannot bypass the five attempt limit', async t => {
  const { request } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 9 }, () => request('/login', { method: 'POST', data: { username: 'admin', password: 'incorrect-password' } })));
  assert.equal(results.filter(result => result.status === 401).length, 5);
  assert.equal(results.filter(result => result.status === 429).length, 4);
  assert.equal((await request('/login', { method: 'POST', data: { username: 'admin', password } })).status, 429);
});

test('oversized and malformed JSON never crash the admin server', async t => {
  const { request, login, base } = await fixture(t); await login();
  assert.equal((await request('/login', { method: 'POST', data: { username: 'admin', password: 'x'.repeat(9000) } })).status, 413);
  const result = await fetch(base + '/api/admin/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(result.status, 400); assert.equal((await request('/session')).status, 200);
});

test('provisioning refuses replacement unless reset is explicit', async t => {
  const { databasePath } = await fixture(t);
  const { provisionAdmin } = await import('../server/admin-init.mjs');
  await assert.rejects(provisionAdmin({ databasePath, username: 'admin', password: 'Replacement-pass-1234' }), /существует|exists/i);
  await provisionAdmin({ databasePath, username: 'admin', password: 'Replacement-pass-1234', reset: true });
});

test('initialization CLI rejects unknown arguments before creating a database', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-admin-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'private.sqlite');
  const result = spawnSync(process.execPath, ['server/admin-init.mjs', '--unknown'], { env: { ...process.env, DATABASE_PATH: databasePath }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stderr, /Использование/);
  await assert.rejects(readFile(databasePath), { code: 'ENOENT' });
});

test('initialization writes secrets beside the selected database and never prints them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-admin-cli-private-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'private.sqlite');
  const env = { ...process.env, DATABASE_PATH: databasePath, ADMIN_INITIAL_PASSWORD: password };
  const run = args => spawnSync(process.execPath, ['server/admin-init.mjs', ...args], { env, encoding: 'utf8', windowsHide: true });
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), join(directory, 'admin-access.txt'));
  assert.doesNotMatch(result.stdout + result.stderr, /Secure-password-12345/);
  const access = await readFile(join(directory, 'admin-access.txt'), 'utf8');
  assert.ok(access.includes(password));
  assert.equal(run([]).status, 1);
  assert.equal(await readFile(join(directory, 'admin-access.txt'), 'utf8'), access);
});

test('audit write failure rolls back the status mutation', async t => {
  const { app, login, request, databasePath } = await fixture(t); await login();
  const id = app.store.save(booking, 'admin-audit-failure', new Date());
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON booking_status_history BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  const response = await request('/bookings/' + id, { method: 'PATCH', data: { status: 'confirmed', expectedStatus: 'requested' } });
  assert.equal(response.status, 503);
  assert.equal(database.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status, 'requested');
  assert.equal(database.prepare('SELECT count(*) AS total FROM booking_status_history').get().total, 0);
  database.close();
});

test('configured HTTPS cookies require HTTPS Origin and are Secure', async t => {
  const { request, base } = await fixture(t, { adminCookieSecure: true });
  assert.equal((await request('/login', { method: 'POST', data: { username: 'admin', password } })).status, 403);
  const response = await request('/login', { method: 'POST', data: { username: 'admin', password }, origin: base.replace('http:', 'https:') });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /; Secure/);
});

test('initialization rejects a missing explicit username without creating files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-admin-cli-name-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'private.sqlite');
  const result = spawnSync(process.execPath, ['server/admin-init.mjs', '--username'], { env: { ...process.env, DATABASE_PATH: databasePath }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); await assert.rejects(readFile(databasePath), { code: 'ENOENT' });
});

test('session and booking history survive a server restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-admin-restart-'));
  const databasePath = join(directory, 'private.sqlite');
  const { provisionAdmin } = await import('../server/admin-init.mjs');
  await provisionAdmin({ databasePath, username: 'admin', password });
  let app = await createApp({ databasePath, now: () => new Date('2026-10-23T09:00:00Z'), telegram: null });
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
  const cookie = login.headers.get('set-cookie').split(';')[0]; const { csrfToken } = await login.json();
  const id = app.store.save(booking, 'admin-restart-0001', new Date());
  app.store.updateStatus(id, 'confirmed', new Date(), { expectedStatus: 'requested', actor: 'admin' });
  await new Promise(resolve => app.server.close(resolve)); app.store.close();
  app = await createApp({ databasePath, now: () => new Date('2026-10-23T10:00:00Z'), telegram: null });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const restartBase = `http://127.0.0.1:${app.server.address().port}`;
  const session = await fetch(restartBase + '/api/admin/session', { headers: { Cookie: cookie } });
  assert.equal(session.status, 200); assert.deepEqual(await session.json(), { username: 'admin', csrfToken });
  const detail = await (await fetch(restartBase + '/api/admin/bookings/' + id, { headers: { Cookie: cookie } })).json();
  assert.equal(detail.booking.status, 'confirmed'); assert.equal(detail.history[0].actor, 'admin');
});

test('failed login budget expires and untrusted forwarded addresses cannot bypass it', async t => {
  const { request, setTime } = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await request('/login', { method: 'POST', data: { username: 'admin', password: 'incorrect' }, headers: { 'X-Forwarded-For': `192.0.2.${i}` } })).status, 401);
  assert.equal((await request('/login', { method: 'POST', data: { username: 'admin', password }, headers: { 'X-Forwarded-For': '203.0.113.1' } })).status, 429);
  setTime('2026-10-23T09:15:00Z');
  assert.equal((await request('/login', { method: 'POST', data: { username: 'admin', password } })).status, 200);
});
