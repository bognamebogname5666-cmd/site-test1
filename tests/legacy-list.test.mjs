import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../server/list-bookings.mjs', import.meta.url));

test('read-only booking list supports old schemas without migrating the database', async t => {
  for (const fixture of [
    { name: 'before comment and status', columns: '', fields: '', values: '', expected: 'requested' },
    { name: 'with comment before status', columns: ', comment TEXT', fields: ', comment', values: ", 'Legacy comment'", expected: 'Legacy comment' },
    { name: 'with comment and status', columns: ', comment TEXT, status TEXT', fields: ', comment, status', values: ", 'Modern comment', 'confirmed'", expected: 'confirmed' }
  ]) {
    await t.test(fixture.name, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ezh-legacy-list-'));
      const databasePath = join(dir, 'bookings.sqlite');
      const db = new DatabaseSync(databasePath);
      try {
        db.exec(`CREATE TABLE bookings (id TEXT PRIMARY KEY, name TEXT, phone TEXT, date TEXT, time TEXT, guests INTEGER, created_at TEXT${fixture.columns});`);
        db.exec(`INSERT INTO bookings (id, name, phone, date, time, guests, created_at${fixture.fields}) VALUES ('fixture-id', 'Legacy fixture', '+79990000000', '2026-10-23', '12:00', 2, datetime('now')${fixture.values});`);
      } finally { db.close(); }
      const before = await readFile(databasePath);
      try {
        const { stdout } = await run(process.execPath, [cli, '7'], { cwd: dir, env: { ...process.env, DATABASE_PATH: databasePath } });
        assert.match(stdout, /Legacy fixture/);
        assert.match(stdout, new RegExp(fixture.expected));
        assert.deepEqual(await readFile(databasePath), before, 'listing must leave the database bytes and schema unchanged');
      } finally { await rm(dir, { recursive: true, maxRetries: 5, retryDelay: 200 }); }
    });
  }
});

test('booking list validates the requested period even when the database does not exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ezh-list-args-'));
  try {
    await assert.rejects(run(process.execPath, [cli, '0'], {
      cwd: dir, env: { ...process.env, DATABASE_PATH: join(dir, 'missing.sqlite') }
    }), error => error.code === 1 && /365/.test(error.stderr));
  } finally { await rm(dir, { recursive: true }); }
});
