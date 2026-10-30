import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after, before } from 'node:test';
import { createApp } from '../server/index.mjs';
import config from '../shared/config.json' with { type: 'json' };

// Browser plugin not available in this session; use the installed Playwright runtime.
// This app owns a temporary database and ephemeral port: never run against live bookings.
const bundledModule = 'C:/Users/hemar/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const bundledBrowser = 'C:/Users/hemar/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';
const modulePath = process.env.PLAYWRIGHT_MODULE || (existsSync(bundledModule) ? bundledModule : null);
const playwright = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const executablePath = process.env.CHROMIUM_PATH || (existsSync(bundledBrowser) ? bundledBrowser : undefined);
let app, browser, directory, base;
let now = new Date('2026-10-20T09:29:59Z');

before(async () => {
  // An isolated QA process must never send a real notification.
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  directory = await mkdtemp(join(tmpdir(), 'ezh-browser-regressions-'));
  app = await createApp({ databasePath: join(directory, 'test.sqlite'), now: () => now, telegram: null, dev: process.env.QA_BUILT !== '1', hmr: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});

after(async () => {
  await browser?.close();
  if (app) {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await app.vite?.close();
    app.store.close();
  }
  if (directory) {
    const target = resolve(directory);
    assert.ok(isAbsolute(target) && target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith('ezh-browser-regressions-'), 'Only remove the temporary QA directory');
    await rm(target, { recursive: true, force: true });
  }
});

const isExternalMap = url => /(^|\.)((google\.[a-z.]+)|(gstatic\.com)|(googleapis\.com)|(yandex\.[a-z.]+)|(yastatic\.net))$/.test(new URL(url).hostname);

test('map HTML has no iframe src before consent, including with JavaScript disabled', async () => {
  const html = await (await fetch(base)).text();
  const iframe = html.match(/<iframe\b[^>]*\bid=["']cafe-map["'][^>]*>/i)?.[0];
  assert.ok(iframe, 'Map iframe exists in source HTML');
  assert.doesNotMatch(iframe, /\ssrc\s*=/i, 'Removing src in JavaScript is too late: source HTML must have no src');
  const context = await browser.newContext({ javaScriptEnabled: false });
  context.setDefaultTimeout(5000);
  try {
    const page = await context.newPage();
    const mapRequests = [];
    await page.route('**/*', route => {
      if (isExternalMap(route.request().url())) { mapRequests.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('#contacts').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#cafe-map').getAttribute('src'), null);
    assert.equal(await page.locator('#cafe-map').isHidden(), true);
    assert.equal(await page.locator('.map-placeholder').isVisible(), true, 'Static address and map controls remain available without JS');
    assert.ok((await page.locator('.map-placeholder').textContent()).includes(config.address), 'Server-rendered address remains readable without JS');
    assert.deepEqual(mapRequests, []);
  } finally { await context.close(); }
});

test('normal page makes zero external map requests until explicit click and retains fallback after failure', async () => {
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  try {
    const page = await context.newPage();
    const mapRequests = [];
    await page.route('**/*', route => {
      if (isExternalMap(route.request().url())) { mapRequests.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#time')?.options.length > 1);
    await page.locator('#contacts').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#cafe-map').getAttribute('src'), null);
    assert.deepEqual(mapRequests, [], 'No external map request while parsing, initializing, or scrolling');
    const trigger = page.locator('[data-load-map]');
    await trigger.waitFor({ state: 'visible' });
    const mapRequest = page.waitForRequest(request => isExternalMap(request.url()));
    await trigger.click();
    await mapRequest;
    assert.match(await page.locator('#cafe-map').getAttribute('src'), /^https:\/\//);
    assert.ok(mapRequests.length > 0, 'Click starts the map request');
    assert.equal(await page.locator('.map-placeholder').isVisible(), true, 'Address and controls survive failed external load');
    assert.equal(await page.locator('.map-wrap [data-directions]').isVisible(), true);
    assert.equal(await page.locator('#map-status').isVisible(), true);
  } finally { await context.close(); }
});

test('lost saved response, then 503, then cutoff-crossing retry recovers the same SQLite booking', async () => {
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  try {
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-10-20T09:29:59Z'));
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#time')?.options.length > 1);
    await page.locator('#name').fill('Проверка восстановления');
    await page.locator('#phone').fill('+79991234567');
    await page.locator('#date').fill('2026-10-20');
    await page.locator('#time').selectOption('13:00');
    await page.locator('#consent').check();
    const requests = [];
    let savedId, replayId;
    await page.route('**/api/bookings', async route => {
      requests.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
      if (requests.length === 2) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Временная ошибка сервера. Повторите отправку.' }) });
        return;
      }
      const response = await route.fetch();
      const receipt = await response.json();
      if (requests.length === 1) {
        assert.equal(response.status(), 201);
        savedId = receipt.id;
        assert.match(savedId, /^EZH-/);
        await route.abort('failed');
      } else {
        assert.equal(response.status(), 200);
        replayId = receipt.id;
        await route.fulfill({ response });
      }
    });
    const submit = page.locator('#booking-form button[type=submit]');
    await submit.click();
    await page.locator('#form-status').filter({ hasText: 'Связь прервалась' }).waitFor();
    assert.equal(app.store.count(), 1, 'First request was actually saved');
    assert.equal(app.store.find(requests[0].key)?.id, savedId);
    await submit.click();
    await page.locator('#form-status').filter({ hasText: 'Временная ошибка' }).waitFor();
    assert.equal(requests.length, 2);
    now = new Date('2026-10-20T09:30:02Z');
    await page.clock.setFixedTime(now);
    await submit.click();
    await page.locator('#booking-success').waitFor({ state: 'visible', timeout: 4000 }).catch(async () => {
      assert.fail(`Recovery did not show success after ${requests.length} requests. Status: ${await page.locator('#form-status').textContent()}; time error: ${await page.locator('#time-error').textContent()}`);
    });
    assert.equal(requests.length, 3, 'Third attempt reaches the real API after the eligibility cutoff');
    assert.equal(replayId, savedId);
    assert.equal(await page.locator('#booking-fields').isHidden(), true);
    assert.ok((await page.locator('#booking-receipt').textContent()).includes(savedId));
    assert.ok(requests.every(request => request.key === requests[0].key && request.body === requests[0].body), 'All retries retain the exact payload and idempotency key');
    assert.equal(app.store.count(), 1, 'Exactly one row after recovery');
    assert.equal(app.store.find(requests[0].key)?.id, savedId);
  } finally { await context.close(); }
});

test('without JavaScript booking cannot leak guest details through a GET URL', async () => {
  // This privacy regression does not exercise animation. Reduced motion prevents
  // native smooth scrolling between form fields from moving the summary mid-click.
  const context = await browser.newContext({ javaScriptEnabled: false, reducedMotion: 'reduce' });
  context.setDefaultTimeout(5000);
  try {
    const page = await context.newPage();
    const getRequests = [];
    page.on('request', request => {
      if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/bookings') getRequests.push(request.url());
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#name').fill('Личный гость');
    await page.locator('#phone').fill('+79998887766');
    await page.locator('.booking-comment summary').click();
    await page.locator('#comment').fill('Личное пожелание');
    // Native disabled buttons ignore click(), including when JS has failed to initialize.
    await page.locator('#booking-form button[type=submit]').evaluate(button => button.click());
    await page.waitForLoadState('networkidle');
    assert.equal(new URL(page.url()).search, '', 'Guest name, phone, and comment must never enter a URL query');
    assert.deepEqual(getRequests, [], 'Never submit guest details using an API GET');
    assert.equal(await page.locator('#booking-form button[type=submit]').isDisabled(), true);
    assert.equal(await page.locator('#booking-form').getAttribute('method'), 'post');
    assert.equal(await page.locator('#booking-form').getAttribute('action'), '/api/bookings');
  } finally { await context.close(); }
});

test('invalid comment inside closed details opens and focuses its visible field', async () => {
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  try {
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-10-20T09:29:59Z'));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#time')?.options.length > 1);
    await page.locator('#name').fill('Проверка пожелания');
    await page.locator('#phone').fill('+79991234567');
    await page.locator('#date').fill('2026-10-20');
    await page.locator('#time').selectOption('13:00');
    await page.locator('#consent').check();
    await page.locator('.booking-comment summary').click();
    await page.locator('#comment').fill('<invalid>');
    await page.locator('.booking-comment summary').click();
    assert.equal(await page.locator('.booking-comment').evaluate(details => details.open), false);
    await page.locator('#booking-form button[type=submit]').click();
    assert.equal(await page.locator('#comment').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('.booking-comment').evaluate(details => details.open), true, 'Reveal the field containing the error');
    assert.equal(await page.locator('#comment').evaluate(input => input === document.activeElement), true);
    assert.equal(await page.locator('#comment').isVisible(), true);
  } finally { await context.close(); }
});
