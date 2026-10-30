import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBookingStore } from '../server/bookings.mjs';
import { createApp } from '../server/index.mjs';

const booking = { name: 'Анна', phone: '+79991234567', date: '2026-10-21', time: '12:30', guests: 2, comment: '', consent: true };

function readOutbox(path, id) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_outbox'").get(), 'booking delivery must have durable outbox storage');
    return database.prepare('SELECT * FROM notification_outbox WHERE booking_id = ?').get(id);
  } finally { database.close(); }
}

test('failed Telegram delivery survives restart and is retried only when due', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-notify-'));
  const path = join(directory, 'notifications.sqlite');
  let clock = new Date('2026-10-20T09:00:00Z');
  let store = createBookingStore(path);
  let worker;
  try {
    const id = store.save(booking, 'notification-test-key-1', clock, { notify: true });
    assert.equal(readOutbox(path, id).attempts, 0);
    const { createNotificationWorker } = await import('../server/telegram.mjs');
    worker = createNotificationWorker({ store, now: () => clock, send: async () => { throw new Error('offline'); } });
    await worker.flush();
    assert.equal(readOutbox(path, id).attempts, 1);
    assert.equal(readOutbox(path, id).delivered_at, null);
    await worker.stop();
    store.close();
    store = createBookingStore(path);
    worker = createNotificationWorker({ store, now: () => clock, send: async () => {} });
    await worker.flush();
    assert.equal(readOutbox(path, id).attempts, 1, 'backoff must survive process restart');
    clock = new Date('2026-10-20T09:01:00Z');
    await worker.flush();
    assert.equal(readOutbox(path, id).attempts, 2);
    assert.equal(readOutbox(path, id).delivered_at, '2026-10-20T09:01:00.000Z');
    clock = new Date('2026-10-20T10:00:00Z');
    await worker.flush();
    assert.equal(readOutbox(path, id).attempts, 2, 'delivered notification must not be sent again');
    assert.equal(store.count(), 1);
  } finally { await worker?.stop(); store.close(); await rm(directory, { recursive: true }); }
});

test('concurrent workers lease each queued notification once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-notify-lease-'));
  const path = join(directory, 'notifications.sqlite');
  const clock = new Date('2026-10-20T09:00:00Z');
  const store = createBookingStore(path);
  let worker;
  let second;
  try {
    const id = store.save(booking, 'notification-test-key-2', clock, { notify: true });
    assert.equal(readOutbox(path, id).attempts, 0);
    const { createNotificationWorker } = await import('../server/telegram.mjs');
    worker = createNotificationWorker({ store, now: () => clock, send: async () => { await new Promise(resolve => setTimeout(resolve, 20)); } });
    second = createNotificationWorker({ store, now: () => clock, send: async () => {} });
    await Promise.all([worker.flush(), second.flush()]);
    assert.equal(readOutbox(path, id).attempts, 1);
    assert.equal(readOutbox(path, id).delivered_at, clock.toISOString());
  } finally { await worker?.stop(); await second?.stop(); store.close(); await rm(directory, { recursive: true }); }
});

test('expired delivery leases recover after restart and stale workers cannot overwrite delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-notify-recovery-'));
  const path = join(directory, 'notifications.sqlite');
  let store = createBookingStore(path);
  try {
    const clock = new Date('2026-10-20T09:00:00Z');
    const id = store.save(booking, 'notification-recovery-key', clock, { notify: true });
    const abandoned = store.claimNotification(clock);
    assert.equal(abandoned.id, id);
    store.close();
    store = createBookingStore(path);
    assert.equal(store.claimNotification(new Date('2026-10-20T09:00:59Z')), null);
    const recovered = store.claimNotification(new Date('2026-10-20T09:01:00Z'));
    assert.equal(recovered.id, id);
    assert.equal(recovered.attempts, 2);
    store.settleNotification(recovered, new Date('2026-10-20T09:01:01Z'), true);
    store.settleNotification(abandoned, new Date('2026-10-20T09:01:02Z'), false);
    assert.equal(readOutbox(path, id).delivered_at, '2026-10-20T09:01:01.000Z');
  } finally { store.close(); await rm(directory, { recursive: true }); }
});

test('outbox storage failure rolls back the booking instead of acknowledging an unqueued delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-notify-atomic-'));
  const path = join(directory, 'notifications.sqlite');
  const store = createBookingStore(path);
  try {
    const database = new DatabaseSync(path);
    database.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END;");
    database.close();
    assert.throws(() => store.save(booking, 'atomic-save-test-key', new Date('2026-10-20T09:00:00Z'), { notify: true }), /outbox unavailable/);
    assert.equal(store.count(), 0);
    assert.equal(store.find('atomic-save-test-key'), undefined);
    // Disabled notifications still save normally while the queue is unavailable.
    store.save(booking, 'atomic-save-test-key', new Date('2026-10-20T09:00:00Z'));
    assert.equal(store.count(), 1);
  } finally { store.close(); await rm(directory, { recursive: true }); }
});

test('booking receipt succeeds while failed Telegram API remains queued, including idempotent replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ezh-notify-api-'));
  const path = join(directory, 'notifications.sqlite');
  const app = await createApp({ databasePath: path, now: () => new Date('2026-10-20T09:00:00Z'), telegram: {
    token: 'test-token', chatId: 'test-chat', fetch: async () => new Response('{"ok":false}', { status: 503 })
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const post = () => fetch(`http://127.0.0.1:${app.server.address().port}/api/bookings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'notification-api-key-1' }, body: JSON.stringify(booking)
  });
  try {
    const first = await post();
    assert.equal(first.status, 201);
    const receipt = await first.json();
    assert.equal(receipt.status, 'requested');
    assert.ok(readOutbox(path, receipt.id));
    await app.notifications.flush();
    assert.equal(readOutbox(path, receipt.id).delivered_at, null);
    const replay = await post();
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).id, receipt.id);
    assert.equal(app.store.count(), 1);
    assert.equal(readOutbox(path, receipt.id).attempts, 1);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    await app.notifications?.stop();
    app.store.close();
    await rm(directory, { recursive: true });
  }
});
