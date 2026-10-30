import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createBookingStore } from '../server/bookings.mjs';
import { createAdminAuthStore } from '../server/admin-auth.mjs';

const modules = () => import('../server/ops-database.mjs');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ezh-ops-'));
  const databasePath = join(directory, 'source.sqlite');
  const store = createBookingStore(databasePath);
  const auth = createAdminAuthStore(databasePath);
  auth.provision('admin', 'synthetic-password-hash', true);
  const db = new DatabaseSync(databasePath);
  db.prepare('INSERT INTO admin_sessions VALUES (?, ?, ?, ?)').run('test-session-hash', 'admin', 'synthetic-csrf', 9_999_999_999_999);
  const value = { name: 'СИНТЕТИЧЕСКАЯ ЗАЯВКА', phone: '+79990000082', date: '2026-10-29', time: '12:30', guests: 2, comment: '', consent: true };
  const old = store.save(value, 'ops-old-synthetic-key', new Date('2026-06-01T09:00:00Z'), { notify: true });
  store.updateStatus(old, 'confirmed', new Date('2026-06-01T10:00:00Z'));
  const boundary = store.save(value, 'ops-boundary-synthetic', new Date('2026-07-30T09:00:00Z'));
  const recent = store.save(value, 'ops-recent-synthetic', new Date('2026-10-28T09:00:00Z'), { notify: true });
  t.after(() => {
    db.close(); auth.close(); store.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, databasePath, store, db, old, boundary, recent };
}
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
test('normalizing a new destination directly under a drive root preserves its entire filename', async () => {
  const { newPrivateDestination } = await modules();
  const path = join(parse(resolve(tmpdir())).root, `ops-path-check-${randomUUID()}.sqlite`);
  assert.equal(newPrivateDestination(path), path);
  assert.equal(existsSync(path), false); // Validation only: never create at the real drive root.
});
test('backup captures uncheckpointed WAL rows without changing the open source database', async t => {
  const f = fixture(t); const { backupDatabase, verifyDatabase } = await modules();
  assert.ok(statSync(f.databasePath + '-wal').size > 0);
  const beforeMain = readFileSync(f.databasePath);
  const beforeWal = readFileSync(f.databasePath + '-wal');
  const destination = join(f.directory, 'backup.sqlite');
  const summary = backupDatabase({ databasePath: f.databasePath, destination });
  assert.equal(summary.bookings, 3); assert.match(summary.sha256, /^[a-f0-9]{64}$/);
  assert.equal(verifyDatabase(destination).schemaVersion, 1);
  assert.deepEqual(readFileSync(f.databasePath), beforeMain);
  assert.deepEqual(readFileSync(f.databasePath + '-wal'), beforeWal);
  const copy = new DatabaseSync(destination, { readOnly: true });
  try { assert.equal(count(copy, 'bookings'), 3); assert.equal(count(copy, 'notification_outbox'), 2); assert.equal(count(copy, 'admin_sessions'), 1); }
  finally { copy.close(); }
});
test('backup and restore never replace an existing destination, even an empty file or source alias', async t => {
  const f = fixture(t); const { backupDatabase, restoreDatabase } = await modules();
  for (const size of [0, 7]) {
    const destination = join(f.directory, `existing-${size}.sqlite`);
    const bytes = Buffer.alloc(size, 82); writeFileSync(destination, bytes);
    for (const operation of [backupDatabase, restoreDatabase]) assert.throws(() => operation({ databasePath: f.databasePath, destination }), /exist|существ/i);
    assert.deepEqual(readFileSync(destination), bytes);
  }
  assert.throws(() => backupDatabase({ databasePath: f.databasePath, destination: f.databasePath }), /exist|source|существ/i);
  assert.equal(f.store.count(), 3);
});
test('restore creates a verified candidate with booking history but no restored sessions', async t => {
  const f = fixture(t); const { backupDatabase, restoreDatabase } = await modules();
  const backup = join(f.directory, 'backup.sqlite'); const candidate = join(f.directory, 'candidate.sqlite');
  backupDatabase({ databasePath: f.databasePath, destination: backup });
  const summary = restoreDatabase({ databasePath: backup, destination: candidate });
  assert.equal(summary.revokedSessions, 1);
  const db = new DatabaseSync(candidate, { readOnly: true });
  try {
    assert.equal(count(db, 'bookings'), 3); assert.equal(count(db, 'booking_status_history'), 1);
    assert.equal(count(db, 'admin_sessions'), 0); assert.equal(count(db, 'admin_users'), 1);
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(f.old).status, 'confirmed');
  } finally { db.close(); }
  assert.equal(count(f.db, 'admin_sessions'), 1);
});
test('corrupt or unsupported sources fail before publishing a backup or candidate', async t => {
  const f = fixture(t); const { backupDatabase, restoreDatabase } = await modules();
  const corrupt = join(f.directory, 'corrupt.sqlite'); writeFileSync(corrupt, 'not a SQLite database');
  const empty = join(f.directory, 'wrong-schema.sqlite'); const db = new DatabaseSync(empty); db.close();
  for (const databasePath of [corrupt, empty, join(f.directory, 'missing.sqlite')]) {
    for (const operation of [backupDatabase, restoreDatabase]) {
      const destination = join(f.directory, 'must-not-publish.sqlite');
      assert.throws(() => operation({ databasePath, destination })); assert.equal(existsSync(destination), false);
    }
  }
  assert.equal(existsSync(join(f.directory, 'missing.sqlite')), false);
});
test('backup refuses public and dist destinations before writing anything', async t => {
  const f = fixture(t); const { backupDatabase } = await modules();
  for (const directory of ['public', 'dist']) {
    const destination = resolve(directory, 'ops-must-not-create.sqlite');
    assert.throws(() => backupDatabase({ databasePath: f.databasePath, destination }), /private|public|dist|закрыт/i);
    assert.equal(existsSync(destination), false);
  }
});
test('purge defaults to a readonly dry run with an exact ninety day created_at boundary', async t => {
  const f = fixture(t); const { purgeBookings } = await modules();
  const before = readFileSync(f.databasePath + '-wal');
  const result = purgeBookings({ databasePath: f.databasePath, now: new Date('2026-10-28T09:00:00Z') });
  assert.equal(result.applied, false); assert.equal(result.cutoff, '2026-07-30T09:00:00.000Z');
  assert.equal(result.bookings, 1); assert.equal(result.pendingNotifications, 1); assert.equal(result.history, 1);
  assert.equal(f.store.count(), 3); assert.deepEqual(readFileSync(f.databasePath + '-wal'), before);
});
test('explicit purge deletes only old bookings and their dependent history/outbox in one transaction', async t => {
  const f = fixture(t); const { purgeBookings } = await modules();
  const result = purgeBookings({ databasePath: f.databasePath, apply: true, now: new Date('2026-10-28T09:00:00Z') });
  assert.equal(result.applied, true); assert.equal(result.bookings, 1);
  assert.equal(f.store.getBooking(f.old), undefined); assert.ok(f.store.getBooking(f.boundary)); assert.ok(f.store.getBooking(f.recent));
  assert.equal(count(f.db, 'notification_outbox'), 1); assert.equal(count(f.db, 'booking_status_history'), 0);
  assert.equal(count(f.db, 'admin_sessions'), 1); assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});
test('purge rolls back dependent deletions if removing a booking fails', async t => {
  const f = fixture(t); const { purgeBookings } = await modules();
  f.db.exec("CREATE TRIGGER block_purge BEFORE DELETE ON bookings BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END");
  assert.throws(() => purgeBookings({ databasePath: f.databasePath, apply: true, now: new Date('2026-10-28T09:00:00Z') }));
  assert.equal(f.store.count(), 3); assert.equal(count(f.db, 'notification_outbox'), 2); assert.equal(count(f.db, 'booking_status_history'), 1);
});
test('invalid retention values cannot trigger a purge', async t => {
  const f = fixture(t); const { purgeBookings } = await modules();
  for (const days of [0, -1, NaN, '90', 1.5, 3651]) assert.throws(() => purgeBookings({ databasePath: f.databasePath, days, apply: true }));
  assert.throws(() => purgeBookings({ databasePath: f.databasePath, now: new Date('invalid'), apply: true }));
  assert.equal(f.store.count(), 3);
});
async function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/ops.mjs', ...args], { windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
test('CLI dry run leaves rows unchanged and unknown or duplicate options fail closed', async t => {
  const f = fixture(t);
  const result = await cli(['purge', '--database', f.databasePath, '--days', '3650']);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).applied, false); assert.equal(f.store.count(), 3);
  for (const args of [['purge', '--database', f.databasePath, '--aply'], ['purge', '--database', f.databasePath, '--days', '90', '--days', '1'], ['backup', '--database', f.databasePath], ['purge']]) {
    const failed = await cli(args); assert.equal(failed.code, 1); assert.equal(f.store.count(), 3);
  }
});
test('health CLI reports readiness, rejects false success, and times out a stalled local endpoint', async t => {
  const server = createServer((request, response) => {
    if (request.url === '/stall') return;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ service: 'semeyniy-ezh', ready: request.url === '/ready' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await cli(['health', '--url', base + '/ready'])).code, 0);
  assert.equal((await cli(['health', '--url', base + '/not-ready'])).code, 1);
  const started = Date.now();
  const stalled = await cli(['health', '--url', base + '/stall', '--timeout-ms', '100']);
  assert.equal(stalled.code, 1); assert.ok(Date.now() - started < 5000);
  assert.equal((await cli(['health', '--url', 'file:///C:/private'])).code, 1);
});
