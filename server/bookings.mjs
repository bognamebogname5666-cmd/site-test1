import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** @typedef {{ name: string, phone: string, date: string, time: string, guests: number, comment: string, consent: true }} BookingValue */

/** SQLite owns booking durability; Telegram delivery is an independent outbox. */
export function createBookingStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL,
      name TEXT NOT NULL, phone TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL,
      guests INTEGER NOT NULL, created_at TEXT NOT NULL, consent_version TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'requested',
      status_updated_at TEXT
    );`);
    const columns = new Set(db.prepare('PRAGMA table_info(bookings)').all().map(column => column.name));
    if (!columns.has('comment')) {
      db.exec("ALTER TABLE bookings ADD COLUMN comment TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.has('status')) {
      db.exec("ALTER TABLE bookings ADD COLUMN status TEXT NOT NULL DEFAULT 'requested'");
    }
    if (!columns.has('status_updated_at')) {
      db.exec('ALTER TABLE bookings ADD COLUMN status_updated_at TEXT');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS notification_outbox (
    booking_id TEXT PRIMARY KEY REFERENCES bookings(id), attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL, delivered_at TEXT, lease_token TEXT
  ); CREATE INDEX IF NOT EXISTS notification_outbox_due ON notification_outbox(next_attempt_at) WHERE delivered_at IS NULL;`);
    db.exec(`CREATE TABLE IF NOT EXISTS booking_status_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL REFERENCES bookings(id),
      at TEXT NOT NULL, actor TEXT NOT NULL, from_status TEXT NOT NULL, to_status TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS booking_status_history_booking ON booking_status_history(booking_id, sequence);
    CREATE INDEX IF NOT EXISTS bookings_status_date ON bookings(status, date);`);
    if (db.prepare('PRAGMA user_version').get().user_version < 1) {
      // Earlier releases added comment without updating old fingerprints. Only
      // repair the exact known pre-comment hash on an empty-comment booking;
      // unrelated fingerprints and requests with comments must stay untouched.
      const updateHash = db.prepare('UPDATE bookings SET payload_hash = ? WHERE id = ? AND payload_hash = ?');
      const legacyBookings = db.prepare("SELECT id, name, phone, date, time, guests, payload_hash FROM bookings WHERE comment = ''").all();
      for (const { id, name, phone, date, time, guests, payload_hash } of legacyBookings) {
        const legacyHash = hash({ name, phone, date, time, guests, consent: true });
        if (payload_hash === legacyHash) {
          updateHash.run(hash({ name, phone, date, time, guests, comment: '', consent: true }), id, legacyHash);
        }
      }
      // Version and repair commit together; subsequent startup avoids the scan.
      db.exec('PRAGMA user_version = 1');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  const insert = db.prepare('INSERT INTO bookings (id, request_key, payload_hash, name, phone, date, time, guests, created_at, consent_version, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const find = db.prepare('SELECT id, payload_hash FROM bookings WHERE request_key = ?');
  const publicColumns = 'id, name, phone, date, time, guests, comment, status, created_at AS createdAt, status_updated_at AS statusUpdatedAt';
  const transitions = { requested: ['confirmed', 'cancelled'], confirmed: ['completed', 'cancelled'], completed: [], cancelled: [] };
  const failure = (message, statusCode) => Object.assign(new Error(message), { statusCode });
  db.function('casefold', value => String(value).toLocaleLowerCase('ru-RU'));
  return {
    find(key) { return find.get(key); },
    /** @param {BookingValue} value */
    save(value, key, now, { notify = false } = {}) {
      const id = `EZH-${randomUUID().slice(0, 8).toUpperCase()}`;
      db.exec('BEGIN IMMEDIATE');
      try {
        insert.run(id, key, hash(value), value.name, value.phone, value.date, value.time, value.guests, now.toISOString(), '2026-10-20', value.comment);
        if (notify) db.prepare('INSERT INTO notification_outbox (booking_id, next_attempt_at) VALUES (?, ?)').run(id, now.toISOString());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return id;
    },
    hash,
    /** Atomic lease coordinates server processes and recovers after a crash. */
    claimNotification(now) {
      const leaseToken = randomUUID();
      const claim = db.prepare(`UPDATE notification_outbox SET attempts = attempts + 1, lease_token = ?, next_attempt_at = ?
        WHERE booking_id = (SELECT booking_id FROM notification_outbox WHERE delivered_at IS NULL AND next_attempt_at <= ? ORDER BY next_attempt_at, booking_id LIMIT 1)
        RETURNING booking_id, attempts`).get(leaseToken, new Date(now.getTime() + 60_000).toISOString(), now.toISOString());
      if (!claim) return null;
      const value = db.prepare('SELECT name, phone, date, time, guests, comment FROM bookings WHERE id = ?').get(claim.booking_id);
      return { id: claim.booking_id, attempts: claim.attempts, leaseToken, value };
    },
    settleNotification(claim, now, delivered) {
      const retryDelay = Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(claim.attempts - 1, 10));
      db.prepare('UPDATE notification_outbox SET delivered_at = ?, next_attempt_at = ?, lease_token = NULL WHERE booking_id = ? AND lease_token = ?')
        .run(delivered ? now.toISOString() : null, new Date(now.getTime() + retryDelay).toISOString(), claim.id, claim.leaseToken);
    },
    /** Local staff workflow. Terminal states cannot accidentally be reopened. */
    updateStatus(id, status, now = new Date(), { expectedStatus, actor = 'local-cli' } = {}) {
      if (!Object.hasOwn(transitions, status)) throw failure('Неизвестный статус заявки.', 400);
      db.exec('BEGIN IMMEDIATE');
      try {
        const booking = db.prepare('SELECT status FROM bookings WHERE id = ?').get(id);
        if (!booking) throw failure('Заявка не найдена.', 404);
        if (expectedStatus !== undefined && expectedStatus !== booking.status) throw failure('Статус изменился одновременно. Проверьте заявку ещё раз.', 409);
        if (booking.status !== status) {
          if (!transitions[booking.status]?.includes(status)) throw failure(`Нельзя изменить статус ${booking.status} на ${status}.`, 409);
          const changed = db.prepare('UPDATE bookings SET status = ?, status_updated_at = ? WHERE id = ? AND status = ?').run(status, now.toISOString(), id, booking.status);
          if (!changed.changes) throw failure('Статус изменился одновременно. Проверьте заявку ещё раз.', 409);
          db.prepare('INSERT INTO booking_status_history (booking_id, at, actor, from_status, to_status) VALUES (?, ?, ?, ?, ?)').run(id, now.toISOString(), actor, booking.status, status);
        }
        db.exec('COMMIT'); return status;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    getBooking(id) { return db.prepare(`SELECT ${publicColumns} FROM bookings WHERE id = ?`).get(id); },
    bookingHistory(id) {
      return db.prepare('SELECT at, actor, from_status AS fromStatus, to_status AS toStatus FROM booking_status_history WHERE booking_id = ? ORDER BY sequence').all(id);
    },
    listBookings({ status = 'all', q = '', dateFrom = '', dateTo = '', page = 1, pageSize = 20 } = {}) {
      const clauses = []; const parameters = [];
      if (status !== 'all') { clauses.push('status = ?'); parameters.push(status); }
      if (q) {
        clauses.push('(instr(casefold(name), ?) > 0 OR instr(phone, ?) > 0 OR instr(casefold(id), ?) > 0)');
        parameters.push(q.toLocaleLowerCase('ru-RU'), q, q.toLocaleLowerCase('ru-RU'));
      }
      if (dateFrom) { clauses.push('date >= ?'); parameters.push(dateFrom); }
      if (dateTo) { clauses.push('date <= ?'); parameters.push(dateTo); }
      const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
      const total = db.prepare('SELECT count(*) AS total FROM bookings' + where).get(...parameters).total;
      const items = db.prepare(`SELECT ${publicColumns} FROM bookings${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...parameters, pageSize, (page - 1) * pageSize);
      const counts = { requested: 0, confirmed: 0, cancelled: 0, completed: 0 };
      for (const row of db.prepare('SELECT status, count(*) AS total FROM bookings GROUP BY status').all()) if (Object.hasOwn(counts, row.status)) counts[row.status] = row.total;
      return { items, total, page, pageSize, counts };
    },
    count() { return db.prepare('SELECT count(*) AS total FROM bookings').get().total; },
    close() { db.close(); }
  };
}
