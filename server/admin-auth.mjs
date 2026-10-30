import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const sessionLifetime = 8 * 60 * 60_000;
export const validUsername = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value);
export const validPassword = value => typeof value === 'string' && value.length >= 12 && value.length <= 128;

export async function hashPassword(password) {
  const salt = randomBytes(24).toString('base64url');
  const key = await derive(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt}$${key.toString('base64url')}`;
}

// Even unknown users perform the same expensive derivation. No user lookup
// result or stored hash is exposed through the HTTP boundary.
const dummyHash = 'scrypt$16384$8$1$unknown-user-fixed-salt$' + Buffer.alloc(64).toString('base64url');
export async function verifyPassword(password, encoded = dummyHash) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [kind, cost, block, parallel, salt, expected] = encoded.split('$');
  if (kind !== 'scrypt' || cost !== '16384' || block !== '8' || parallel !== '1' || !salt || !expected) return false;
  const actual = await derive(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const target = Buffer.from(expected, 'base64url');
  return target.length === actual.length && timingSafeEqual(target, actual);
}

export function createAdminAuthStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS admin_users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES admin_users(username) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at);`);
  return {
    user(username) { return db.prepare('SELECT username, password_hash FROM admin_users WHERE username = ?').get(username); },
    provision(username, passwordHash, reset, now = new Date()) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!reset && db.prepare('SELECT 1 FROM admin_users LIMIT 1').get()) throw new Error('Администратор уже существует. Для сброса явно укажите --reset.');
        if (reset) db.exec('DELETE FROM admin_sessions; DELETE FROM admin_users;');
        db.prepare('INSERT INTO admin_users (username, password_hash, updated_at) VALUES (?, ?, ?)').run(username, passwordHash, now.toISOString());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    createSession(username, passwordHash, now) {
      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now.getTime());
      const result = db.prepare(`INSERT INTO admin_sessions (token_hash, username, csrf_token, expires_at)
        SELECT ?, username, ?, ? FROM admin_users WHERE username = ? AND password_hash = ?`)
        .run(digest(token), csrfToken, now.getTime() + sessionLifetime, username, passwordHash);
      return result.changes ? { token, username, csrfToken } : null;
    },
    session(token, now) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const session = db.prepare('SELECT username, csrf_token AS csrfToken, expires_at AS expiresAt FROM admin_sessions WHERE token_hash = ?').get(digest(token));
      if (!session) return null;
      if (session.expiresAt <= now.getTime()) { db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(digest(token)); return null; }
      return { username: session.username, csrfToken: session.csrfToken };
    },
    logout(token) { if (typeof token === 'string') db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(digest(token)); },
    changePassword(username, previousHash, nextHash, now) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE username = ? AND password_hash = ?').run(nextHash, now.toISOString(), username, previousHash);
        if (result.changes) db.prepare('DELETE FROM admin_sessions WHERE username = ?').run(username);
        db.exec('COMMIT'); return Boolean(result.changes);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); }
  };
}
