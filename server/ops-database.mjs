import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const normalize = path => process.platform === 'win32' ? path.toLowerCase() : path;
const within = (path, root) => normalize(path) === normalize(root) || normalize(path).startsWith(normalize(root + sep));
const schema = {
  bookings: ['id', 'request_key', 'payload_hash', 'name', 'phone', 'date', 'time', 'guests', 'created_at', 'consent_version', 'comment', 'status', 'status_updated_at'],
  notification_outbox: ['booking_id', 'attempts', 'next_attempt_at', 'delivered_at', 'lease_token'],
  booking_status_history: ['sequence', 'booking_id', 'at', 'actor', 'from_status', 'to_status'],
  admin_users: ['username', 'password_hash', 'updated_at'],
  admin_sessions: ['token_hash', 'username', 'csrf_token', 'expires_at']
};
function existingDatabase(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('An explicit database path is required.');
  const actual = realpathSync(resolve(path));
  if (!statSync(actual).isFile()) throw new Error('Database source must be a file.');
  return actual;
}
/** Validate and canonicalize a new private destination without creating it. */
export function newPrivateDestination(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('An explicit new destination path is required.');
  const destination = resolve(path);
  // lstat also detects dangling symlinks: no destination is ever followed or replaced.
  try { lstatSync(destination); throw new Error('Destination already exists; choose a new file.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parent = realpathSync(dirname(destination));
  for (const name of ['public', 'dist']) {
    let root = resolve(projectRoot, name);
    try { root = realpathSync(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (within(parent, root)) throw new Error('Backup and restore destinations must be private, outside public and dist.');
  }
  return join(parent, basename(destination));
}
function inspect(db) {
  const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
  if (schemaVersion !== 1) throw new Error('Unsupported database schema; use a matching application release.');
  for (const [table, required] of Object.entries(schema)) {
    // Table identifiers are this fixed internal allowlist, never command-line input.
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    if (required.some(column => !columns.has(column))) throw new Error('Incomplete application database schema.');
  }
  const check = db.prepare('PRAGMA quick_check').all();
  if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new Error('Database integrity check failed.');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database foreign key check failed.');
  return { schemaVersion, bookings: db.prepare('SELECT count(*) AS total FROM bookings').get().total };
}
export function verifyDatabase(databasePath) {
  const db = new DatabaseSync(existingDatabase(databasePath), { readOnly: true });
  try { return inspect(db); } finally { db.close(); }
}
function snapshot({ databasePath, destination }, revokeSessions) {
  const target = newPrivateDestination(destination);
  const source = existingDatabase(databasePath);
  verifyDatabase(source);
  const parent = dirname(target);
  const stagingDirectory = mkdtempSync(join(parent, '.ezh-ops-'));
  // Only exact names inside this newly created directory are ever cleaned up.
  if (dirname(resolve(stagingDirectory)) !== parent) throw new Error('Invalid staging directory.');
  const staging = join(stagingDirectory, 'snapshot.sqlite');
  try {
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      // SQLite VACUUM INTO reads a consistent snapshot including committed WAL.
      // Unlike node:sqlite.backup(), it is available on supported Node 22.18.
      db.prepare('VACUUM INTO ?').run(staging);
    } finally { db.close(); }
    let revokedSessions = 0;
    if (revokeSessions) {
      const candidate = new DatabaseSync(staging);
      try {
        candidate.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
        revokedSessions = candidate.prepare('DELETE FROM admin_sessions').run().changes;
      } finally { candidate.close(); }
    }
    const summary = verifyDatabase(staging);
    chmodSync(staging, 0o600);
    // Windows FlushFileBuffers requires write access. This is our staged copy,
    // never the read-only source database.
    const descriptor = openSync(staging, 'r+');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    const sha256 = createHash('sha256').update(readFileSync(staging)).digest('hex');
    // Hard-link publication is atomic and fails if ANY destination appeared
    // after validation. No rename-overwrite or copy onto a running DB is used.
    linkSync(staging, target);
    return { path: target, ...summary, sha256, ...(revokeSessions ? { revokedSessions } : {}) };
  } finally {
    for (const path of [staging, staging + '-wal', staging + '-shm', staging + '-journal']) {
      try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    rmdirSync(stagingDirectory);
  }
}
export function backupDatabase(options) { return snapshot(options, false); }
export function restoreDatabase(options) { return snapshot(options, true); }

export function purgeBookings({ databasePath, days = 90, apply = false, now = new Date() }) {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Retention days must be an integer from 1 to 3650.');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('A valid current time is required.');
  if (typeof apply !== 'boolean') throw new Error('Apply must be an explicit boolean.');
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const db = new DatabaseSync(existingDatabase(databasePath), { readOnly: !apply });
  let transaction = false;
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    inspect(db);
    if (apply) db.exec('PRAGMA secure_delete=ON;');
    db.exec(apply ? 'BEGIN IMMEDIATE' : 'BEGIN'); transaction = true;
    const older = 'SELECT id FROM bookings WHERE julianday(created_at) < julianday(?)';
    const number = sql => db.prepare(sql).get(cutoff).total;
    const summary = {
      applied: apply, days, cutoff,
      bookings: number(`SELECT count(*) AS total FROM bookings WHERE id IN (${older})`),
      history: number(`SELECT count(*) AS total FROM booking_status_history WHERE booking_id IN (${older})`),
      notifications: number(`SELECT count(*) AS total FROM notification_outbox WHERE booking_id IN (${older})`),
      pendingNotifications: number(`SELECT count(*) AS total FROM notification_outbox WHERE delivered_at IS NULL AND booking_id IN (${older})`)
    };
    if (apply) {
      db.prepare(`DELETE FROM notification_outbox WHERE booking_id IN (${older})`).run(cutoff);
      db.prepare(`DELETE FROM booking_status_history WHERE booking_id IN (${older})`).run(cutoff);
      db.prepare(`DELETE FROM bookings WHERE id IN (${older})`).run(cutoff);
    }
    db.exec('COMMIT'); transaction = false;
    return summary;
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}
