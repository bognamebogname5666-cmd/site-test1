import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createBookingStore } from '../server/bookings.mjs';
import { createHash } from 'node:crypto';
import { createApp } from '../server/index.mjs';

const booking = { name: 'Анна', phone: '+79991234567', date: '2026-10-21', time: '12:30', guests: 2, comment: '', consent: true };

test('local staff CLI persists booking status and rejects invalid transitions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-staff-'));
  const databasePath = join(directory, 'staff.sqlite');
  const store = createBookingStore(databasePath);
  const id = store.save(booking, 'staff-booking-key-0001', new Date());
  store.close();
  const command = status => spawnSync(process.execPath, [resolve('server/manage-bookings.mjs'), id, status], {
    env: { ...process.env, DATABASE_PATH: databasePath }, encoding: 'utf8', windowsHide: true
  });
  try {
    const confirmed = command('confirmed');
    assert.equal(confirmed.status, 0, confirmed.stderr);
    let db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status, 'confirmed');
    db.close();
    assert.equal(command('requested').status, 1);
    assert.equal(command('completed').status, 0);
    assert.equal(command('cancelled').status, 1);
    db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status, 'completed');
    db.close();
    const listing = spawnSync(process.execPath, [resolve('server/list-bookings.mjs'), '365'], {
      env: { ...process.env, DATABASE_PATH: databasePath }, encoding: 'utf8', windowsHide: true
    });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /completed/);
  } finally { await rm(directory, { recursive: true }); }
});

test('staff CLI validates arguments before opening or creating a database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-staff-invalid-'));
  const databasePath = join(directory, 'does-not-exist.sqlite');
  try {
    const result = spawnSync(process.execPath, [resolve('server/manage-bookings.mjs'), 'bad-id', 'confirmed'], {
      env: { ...process.env, DATABASE_PATH: databasePath }, encoding: 'utf8', windowsHide: true
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EZH-|идентификатор/i);
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true }); }
});

test('existing database upgrades preserve bookings and default their staff status to requested', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-staff-migration-'));
  const path = join(directory, 'legacy.sqlite');
  let store;
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE bookings (
      id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL,
      name TEXT NOT NULL, phone TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL,
      guests INTEGER NOT NULL, created_at TEXT NOT NULL, consent_version TEXT NOT NULL
    );`);
    legacy.prepare('INSERT INTO bookings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('EZH-1234ABCD', 'legacy-request-key', 'legacy-hash', 'Анна', '+79991234567', '2026-10-21', '12:30', 2, '2026-10-20T09:00:00.000Z', '2026-10-20');
    legacy.close();
    store = createBookingStore(path);
    assert.equal(store.count(), 1);
    assert.equal(store.find('legacy-request-key').id, 'EZH-1234ABCD');
    const database = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual({ ...database.prepare('SELECT status, comment FROM bookings').get() }, { status: 'requested', comment: '' });
    database.close();
    assert.equal(store.updateStatus('EZH-1234ABCD', 'confirmed'), 'confirmed');
  } finally { store?.close(); await rm(directory, { recursive: true }); }
});

test('a booking saved before comments were introduced still recovers its original receipt after migration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-legacy-replay-'));
  const path = join(directory, 'legacy.sqlite');
  const legacyValue = { name: 'Анна', phone: '+79991234567', date: '2026-10-21', time: '12:30', guests: 2, consent: true };
  const key = 'legacy-replay-key-0001';
  let app;
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE bookings (
      id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL,
      name TEXT NOT NULL, phone TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL,
      guests INTEGER NOT NULL, created_at TEXT NOT NULL, consent_version TEXT NOT NULL
    );`);
    const hash = createHash('sha256').update(JSON.stringify(legacyValue)).digest('hex');
    legacy.prepare('INSERT INTO bookings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('EZH-1234ABCD', key, hash, 'Анна', '+79991234567', '2026-10-21', '12:30', 2, '2026-10-20T09:00:00.000Z', '2026-10-20');
    legacy.close();
    app = await createApp({ databasePath: path, now: () => new Date('2026-10-22T09:00:00Z') });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const post = data => fetch(`http://127.0.0.1:${app.server.address().port}/api/bookings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(data)
    });
    const replay = await post(legacyValue);
    assert.equal(replay.status, 200, 'an identical legacy request must recover even after its date passes');
    assert.deepEqual(await replay.json(), { id: 'EZH-1234ABCD', status: 'requested' });
    const changed = await post({ ...legacyValue, guests: 3 });
    assert.equal(changed.status, 409, 'migration must preserve conflict detection');
    const conflict = await changed.json();
    assert.doesNotMatch(conflict.message, /обновите|новой заявки/i, 'conflict recovery must not advise creating a duplicate');
    assert.equal(app.store.count(), 1);
  } finally {
    if (app) { await new Promise(resolve => app.server.close(resolve)); app.store.close(); }
    await rm(directory, { recursive: true });
  }
});

test('a failed legacy hash migration rolls back its schema changes and can be retried safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-legacy-migration-atomic-'));
  const path = join(directory, 'legacy.sqlite');
  let store;
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE bookings (
      id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL,
      name TEXT NOT NULL, phone TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL,
      guests INTEGER NOT NULL, created_at TEXT NOT NULL, consent_version TEXT NOT NULL
    );`);
    const legacyHash = createHash('sha256').update(JSON.stringify({ name: 'Анна', phone: '+79991234567', date: '2026-10-21', time: '12:30', guests: 2, consent: true })).digest('hex');
    legacy.prepare('INSERT INTO bookings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('EZH-1234ABCD', 'legacy-atomic-key', legacyHash, 'Анна', '+79991234567', '2026-10-21', '12:30', 2, '2026-10-20T09:00:00.000Z', '2026-10-20');
    legacy.exec("CREATE TRIGGER reject_rehash BEFORE UPDATE OF payload_hash ON bookings BEGIN SELECT RAISE(ABORT, 'migration interrupted'); END;");
    legacy.close();
    assert.throws(() => createBookingStore(path), /migration interrupted/);
    const inspection = new DatabaseSync(path);
    assert.equal(inspection.prepare('PRAGMA table_info(bookings)').all().some(column => column.name === 'comment'), false);
    assert.equal(inspection.prepare('SELECT payload_hash FROM bookings').get().payload_hash, legacyHash);
    assert.equal(inspection.prepare('PRAGMA user_version').get().user_version, 0);
    inspection.exec('DROP TRIGGER reject_rehash');
    inspection.close();
    store = createBookingStore(path);
    assert.equal(store.count(), 1);
    assert.equal(store.updateStatus('EZH-1234ABCD', 'confirmed'), 'confirmed');
  } finally { store?.close(); await rm(directory, { recursive: true }); }
});

test('already upgraded databases repair only known legacy fingerprints once and preserve original API receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-legacy-comment-repair-'));
  const path = join(directory, 'legacy.sqlite');
  const legacyValue = { name: 'Анна', phone: '+79991234567', date: '2026-10-21', time: '12:30', guests: 2, consent: true };
  const legacyHash = createHash('sha256').update(JSON.stringify(legacyValue)).digest('hex');
  const currentHash = createHash('sha256').update(JSON.stringify(booking)).digest('hex');
  let app;
  let reopened;
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE bookings (
      id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL,
      name TEXT NOT NULL, phone TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL,
      guests INTEGER NOT NULL, created_at TEXT NOT NULL, consent_version TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT ''
    );`);
    const insert = legacy.prepare('INSERT INTO bookings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [id, key, hash, comment] of [
      ['EZH-1234ABCD', 'already-upgraded-key', legacyHash, ''],
      ['EZH-00000002', 'arbitrary-hash-key', 'unrecognized-hash', ''],
      ['EZH-00000003', 'commented-booking-key', legacyHash, 'У окна'],
      ['EZH-00000004', 'current-booking-key', currentHash, '']
    ]) insert.run(id, key, hash, 'Анна', '+79991234567', '2026-10-21', '12:30', 2, '2026-10-20T09:00:00.000Z', '2026-10-20', comment);
    legacy.close();
    app = await createApp({ databasePath: path, now: () => new Date('2026-10-22T09:00:00Z') });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const replay = await fetch(`http://127.0.0.1:${app.server.address().port}/api/bookings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'already-upgraded-key' }, body: JSON.stringify(legacyValue)
    });
    assert.equal(replay.status, 200, 'a previously upgraded empty-comment booking must recover its receipt');
    assert.deepEqual(await replay.json(), { id: 'EZH-1234ABCD', status: 'requested' });
    assert.equal(app.store.find('arbitrary-hash-key').payload_hash, 'unrecognized-hash');
    assert.equal(app.store.find('commented-booking-key').payload_hash, legacyHash);
    assert.equal(app.store.find('current-booking-key').payload_hash, currentHash);
    const inspection = new DatabaseSync(path);
    assert.equal(inspection.prepare('PRAGMA user_version').get().user_version, 1);
    // A later matching row proves startup does not rescan an already repaired DB.
    inspection.prepare('UPDATE bookings SET payload_hash = ? WHERE request_key = ?').run(legacyHash, 'current-booking-key');
    inspection.close();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
    app = undefined;
    reopened = createBookingStore(path);
    assert.equal(reopened.find('current-booking-key').payload_hash, legacyHash);
  } finally {
    if (app) { await new Promise(resolve => app.server.close(resolve)); app.store.close(); }
    reopened?.close();
    await rm(directory, { recursive: true });
  }
});
