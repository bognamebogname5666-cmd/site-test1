import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createApp } from '../server/index.mjs';

test('production HTML and its CSS/JS are served regardless of working directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ezh-cwd-'));
  const original = process.cwd();
  let app;
  try {
    process.chdir(dir);
    app = await createApp({ databasePath: join(dir, 'bookings.sqlite'), telegram: null });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(base);
    assert.equal(response.status, 200);
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:css|js))"/g)].map(match => match[1]);
    assert.ok(assets.some(path => path.endsWith('.css')));
    assert.ok(assets.some(path => path.endsWith('.js')));
    for (const path of assets) {
      const asset = await fetch(new URL(path, base));
      assert.equal(asset.status, 200, path);
      assert.match(asset.headers.get('content-type'), path.endsWith('.css') ? /text\/css/ : /javascript/);
    }
  } finally {
    if (app) { await new Promise(resolve => app.server.close(resolve)); app.store.close(); }
    process.chdir(original);
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())));
    await rm(dir, { recursive: true });
  }
});

test('health endpoint identifies the ready coffee site without exposing customer data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ezh-health-'));
  const app = await createApp({ databasePath: join(dir, 'bookings.sqlite'), telegram: null });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { service: 'semeyniy-ezh', ready: true });
  } finally {
    await new Promise(resolve => app.server.close(resolve)); app.store.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())));
    await rm(dir, { recursive: true });
  }
});

test('launcher starts a ready server and reuses it on the second launch', async () => {
  const { ensureSiteRunning } = await import('../server/launch.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'ezh-launch-'));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const original = process.cwd();
  const savedEnv = Object.fromEntries(['HOST', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].map(key => [key, process.env[key]]));
  process.env.HOST = '127.0.0.1';
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.TELEGRAM_CHAT_ID = '';
  let result;
  try {
    process.chdir(dir);
    result = await ensureSiteRunning({ port, databasePath: join(dir, 'bookings.sqlite') });
    assert.equal(result.started, true);
    assert.ok(result.pid > 0);
    const again = await ensureSiteRunning({ port, databasePath: join(dir, 'bookings.sqlite') });
    assert.equal(again.started, false);
    assert.equal(again.url, result.url);
    assert.equal((await fetch(result.url)).status, 200);
  } finally {
    if (result?.pid) { process.kill(result.pid); await new Promise(resolve => setTimeout(resolve, 300)); }
    process.chdir(original);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())));
    await rm(dir, { recursive: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('launcher probes and opens the configured host, including IPv6 and wildcard bindings', async t => {
  const { ensureSiteRunning } = await import('../server/launch.mjs');
  const originalHost = process.env.HOST;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.TELEGRAM_CHAT_ID = '';
  try {
    for (const fixture of [
      { host: '::1', inherited: true, expectedHost: '[::1]', bind: '::1' },
      { host: '::1', inherited: false, expectedHost: '[::1]', bind: '::1' },
      { host: '0.0.0.0', inherited: false, expectedHost: '127.0.0.1', bind: '127.0.0.1' },
      { host: '::', inherited: false, expectedHost: '[::1]', bind: '::1' }
    ]) {
      await t.test(`${fixture.inherited ? 'inherited' : 'explicit'} HOST=${fixture.host}`, async t => {
        const reservation = createServer();
        try {
          await new Promise((resolve, reject) => {
            reservation.once('error', reject);
            reservation.listen(0, fixture.bind, resolve);
          });
        } catch (error) {
          if (fixture.bind === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) {
            t.skip('IPv6 loopback is unavailable on this system');
            return;
          }
          throw error;
        }
        const port = reservation.address().port;
        await new Promise(resolve => reservation.close(resolve));
        const dir = await mkdtemp(join(tmpdir(), 'ezh-host-'));
        let result;
        process.env.HOST = fixture.inherited ? fixture.host : '127.0.0.1';
        try {
          const options = { port, databasePath: join(dir, 'bookings.sqlite'), ...(fixture.inherited ? {} : { host: fixture.host }) };
          result = await ensureSiteRunning(options);
          assert.equal(result.started, true);
          assert.ok(result.pid > 0);
          assert.equal(result.url, `http://${fixture.expectedHost}:${port}/`);
          assert.equal((await fetch(new URL('/api/health', result.url))).status, 200);
          const again = await ensureSiteRunning(options);
          assert.equal(again.started, false);
          assert.equal(again.url, result.url);
        } finally {
          if (result?.pid) { process.kill(result.pid); await new Promise(resolve => setTimeout(resolve, 300)); }
          assert.ok(resolve(dir).startsWith(resolve(tmpdir())));
          await rm(dir, { recursive: true, maxRetries: 5, retryDelay: 200 });
        }
      });
    }
  } finally {
    for (const [key, value] of [['HOST', originalHost], ['TELEGRAM_BOT_TOKEN', originalToken], ['TELEGRAM_CHAT_ID', originalChat]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('launcher rejects invalid ports before starting a server', async () => {
  const { ensureSiteRunning } = await import('../server/launch.mjs');
  for (const port of [0, -1, 65536, 1.5, NaN]) {
    await assert.rejects(ensureSiteRunning({ port }), /PORT/);
  }
});
