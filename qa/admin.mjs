import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';
import { createApp } from '../server/index.mjs';

// Browser plugin not available; use the installed Playwright runtime.
// This script owns its ephemeral server and SQLite database; never pass a live URL.
const bundledModule = 'C:/Users/hemar/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const bundledBrowser = 'C:/Users/hemar/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';
const axePath = process.env.AXE_PATH || 'C:/Users/hemar/.codex/visualizations/2026/10/20/01a15a2f-c024-7230-980f-084caa1a02ac/fresh-independent-tools/package/axe.min.js';
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : existsSync(bundledModule) ? pathToFileURL(bundledModule).href : 'playwright');
const username = 'qa-admin';
const password = 'Isolated-QA-password-12345';
const fixtures = [
  { name: 'Тест Анна', phone: '+79991110001', date: '2026-10-24', time: '12:30', guests: 2, comment: 'У окна, пожалуйста', consent: true },
  { name: 'Тест Борис', phone: '+79991110002', date: '2026-10-24', time: '14:00', guests: 3, comment: 'Нужен детский стул', consent: true },
  { name: 'Тест Вера', phone: '+79991110003', date: '2026-10-25', time: '12:30', guests: 4, comment: 'Встреча друзей', consent: true },
  { name: 'Тест Глеб', phone: '+79991110004', date: '2026-10-25', time: '14:00', guests: 1, comment: '', consent: true },
];
let app, browser, directory, databasePath, base, output;
let now = new Date('2026-10-23T07:00:00Z');
const ids = [];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ezh-admin-qa-data-'));
  output = process.env.QA_OUTPUT || await mkdtemp(join(tmpdir(), 'ezh-admin-qa-evidence-'));
  await mkdir(output, { recursive: true });
  databasePath = join(directory, 'test.sqlite');
  const { provisionAdmin } = await import('../server/admin-init.mjs');
  await provisionAdmin({ databasePath, username, password });
  app = await createApp({ databasePath, now: () => now, telegram: null, rateLimit: 20, dev: process.env.QA_BUILT === '0', hmr: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  for (const [index, booking] of fixtures.entries()) {
    const response = await fetch(`${base}/api/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `admin-ui-fixture-key-${index}` }, body: JSON.stringify(booking) });
    assert.equal(response.status, 201, await response.clone().text());
    ids.push((await response.json()).id);
  }
  const executablePath = process.env.CHROMIUM_PATH || (existsSync(bundledBrowser) ? bundledBrowser : undefined);
  browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  console.log(`Admin QA: ${base}; screenshots: ${output}`);
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
    assert.ok(isAbsolute(target) && target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith('ezh-admin-qa-data-'));
    await rm(target, { recursive: true, force: true });
  }
});

test('/admin/ serves a dedicated administrative login page', async () => {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(5000);
  try {
    const page = await context.newPage();
    await page.goto(`${base}/admin/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    assert.equal(await page.locator('#admin-login-form').count(), 1, `Missing admin login at ${page.url()}; title: ${await page.title()}`);
    await page.locator('#admin-login-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#booking-form').count(), 0, 'Dedicated page must not fall through to the public cafe page');
    assert.match(await page.title(), /заяв|админ|панель/iu);
    await auditAccessibility(page);
    await page.screenshot({ path: join(output, 'admin-login-1440.png'), timeout: 30000 });
  } finally { await context.close(); }
});

test('admin APIs deny direct unauthenticated access to guest information', async () => {
  for (const path of ['/session', '/bookings', `/bookings/${ids[0]}`]) {
    const response = await fetch(`${base}/api/admin${path}`);
    assert.equal(response.status, 401, path);
    assert.ok(!JSON.stringify(await response.json()).includes(fixtures[0].phone));
  }
});

const dbStatus = id => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { return database.prepare('SELECT status FROM bookings WHERE id = ?').get(id)?.status; }
  finally { database.close(); }
};
const action = (page, id, status) => page.locator(`[data-admin-action="${status}"][data-id="${id}"]`);
async function auditAccessibility(page) {
  if (!existsSync(axePath)) return;
  await page.evaluate(await readFile(axePath, 'utf8'));
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
    return result.violations.map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) }));
  });
  assert.deepEqual(violations, [], 'Admin page has no automated WCAG A/AA violations');
}
const waitList = page => page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/bookings' && response.request().method() === 'GET');
async function refresh(page) {
  const pending = waitList(page);
  await page.locator('#admin-refresh').click();
  assert.equal((await pending).status(), 200);
}
async function applyFilters(page) {
  const pending = waitList(page);
  await page.locator('#admin-filter-form button[type="submit"]').click();
  assert.equal((await pending).status(), 200);
  await page.waitForFunction(() => document.querySelector('#admin-results')?.getAttribute('aria-busy') === 'false');
}
async function login(page, value = password) {
  await page.locator('#admin-username').fill(username);
  await page.locator('#admin-password').fill(value);
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/login');
  await page.locator('#admin-login-form button[type="submit"]').click();
  return pending;
}

test('administrator can manage real bookings, recover stale views and revoke the session', async t => {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(5000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/admin/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await t.test('invalid credentials show an error; valid credentials render the saved guest details', async () => {
      assert.equal((await login(page, 'Incorrect-QA-password')).status(), 401);
      await page.locator('#admin-login-status').filter({ hasText: /\S/u }).waitFor();
      assert.equal(await page.locator('#admin-dashboard').isHidden(), true);
      assert.equal((await login(page)).status(), 200);
      await page.locator('#admin-dashboard').waitFor({ state: 'visible' });
      await page.locator('#admin-results').filter({ hasText: ids[0] }).waitFor();
      for (const fixture of fixtures) assert.ok((await page.locator('#admin-results').innerText()).includes(fixture.name));
      const details = page.locator('#admin-results details');
      for (const detail of await details.all()) if (!(await detail.evaluate(node => node.open))) await detail.locator('summary').click();
      const content = await page.locator('#admin-results').innerText();
      assert.ok(content.includes(fixtures[0].comment), 'Saved guest comment is readable');
      assert.ok(content.replace(/[\s()\-]/gu, '').includes(fixtures[0].phone), 'Saved phone is readable');
      assert.ok(content.includes(fixtures[0].time), 'Saved booking time is readable');
      const session = await (await context.request.get(`${base}/api/admin/session`)).json();
      assert.equal(session.username, username);
      assert.ok(session.csrfToken);
    });
    // A failed login must not cascade into clicks on missing controls.
    if (!(await page.locator('#admin-dashboard').isVisible())) return;

    await t.test('search, status and date controls filter the displayed saved bookings', async () => {
      await page.locator('#admin-search').fill('Тест Анна');
      await applyFilters(page);
      await page.waitForFunction(id => document.querySelector('#admin-results')?.textContent.includes(id) && !document.querySelector('#admin-results')?.textContent.includes('Тест Борис'), ids[0]);
      await page.locator('#admin-search').fill('');
      await applyFilters(page);
      await page.locator('#admin-status').selectOption('completed');
      await applyFilters(page);
      assert.ok(!(await page.locator('#admin-results').innerText()).includes(ids[0]), 'Requested booking excluded from completed filter');
      await page.locator('#admin-status').selectOption('all');
      await page.locator('#admin-date-from').fill('2026-10-25');
      await page.locator('#admin-date-to').fill('2026-10-25');
      await applyFilters(page);
      await page.locator('#admin-results').filter({ hasText: ids[2] }).waitFor();
      const content = await page.locator('#admin-results').innerText();
      assert.ok(!content.includes(ids[0]) && !content.includes(ids[1]));
      await page.locator('#admin-date-from').fill('');
      await page.locator('#admin-date-to').fill('');
      await applyFilters(page);
      await action(page, ids[0], 'confirmed').waitFor();
    });

    await t.test('confirm persists in SQLite and survives reload with an authenticated session', async () => {
      await action(page, ids[0], 'confirmed').click();
      await action(page, ids[0], 'completed').waitFor();
      assert.equal(dbStatus(ids[0]), 'confirmed');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.locator('#admin-dashboard').waitFor({ state: 'visible' });
      await action(page, ids[0], 'completed').waitFor();
      assert.equal((await context.request.get(`${base}/api/admin/session`)).status(), 200);
      assert.equal(dbStatus(ids[0]), 'confirmed');
      await page.locator(`[data-admin-detail="${ids[0]}"]`).click();
      await page.locator('#admin-detail-dialog').waitFor({ state: 'visible' });
      const detail = await page.locator('#admin-detail-body').innerText();
      assert.ok(detail.includes(fixtures[0].comment) && detail.includes(username), 'Detailed history shows the real guest comment and staff actor');
      await page.keyboard.press('Escape');
      await page.locator('#admin-detail-dialog').waitFor({ state: 'hidden' });
    });

    await t.test('cancel and complete apply legal transitions and remove unavailable actions', async () => {
      const completeResponse = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(ids[0]));
      await action(page, ids[0], 'completed').click();
      assert.equal((await completeResponse).status(), 200);
      await refresh(page);
      assert.equal(dbStatus(ids[0]), 'completed');
      assert.equal(await action(page, ids[0], 'cancelled').count(), 0);
      const cancelResponse = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(ids[1]));
      await action(page, ids[1], 'cancelled').click();
      assert.equal((await cancelResponse).status(), 200);
      await refresh(page);
      assert.equal(dbStatus(ids[1]), 'cancelled');
      assert.equal(await action(page, ids[1], 'confirmed').count(), 0);
    });

    await t.test('stale status conflict is explained and displays the latest saved state', async () => {
      const session = await (await context.request.get(`${base}/api/admin/session`)).json();
      // Another operator changes the real row after this screen rendered it.
      const response = await context.request.patch(`${base}/api/admin/bookings/${ids[2]}`, { headers: { Origin: base, 'X-CSRF-Token': session.csrfToken }, data: { status: 'confirmed', expectedStatus: 'requested' } });
      assert.equal(response.status(), 200);
      const conflict = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(ids[2]));
      await action(page, ids[2], 'cancelled').click();
      const conflictResponse = await conflict;
      assert.equal(conflictResponse.status(), 409);
      await page.locator('#admin-status-message').filter({ hasText: /измени|устар/iu }).waitFor();
      assert.equal(dbStatus(ids[2]), 'confirmed', 'Conflicting old view must not overwrite another operator');
      await refresh(page);
      await action(page, ids[2], 'completed').waitFor();
    });

    await t.test('desktop and two mobile widths retain usable forms, results and healthy runtime', async () => {
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => window.scrollTo(0, 0));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px horizontal overflow`);
        await page.screenshot({ path: join(output, `admin-dashboard-${width}.png`), fullPage: true, timeout: 30000 });
      }
      assert.equal(await page.locator('vite-error-overlay').count(), 0);
      assert.deepEqual(errors, []);
      await auditAccessibility(page);
    });

    await t.test('logout revokes the saved session and reload keeps guest information private', async () => {
      const cookie = (await context.cookies(`${base}/api/admin/session`)).map(item => `${item.name}=${item.value}`).join('; ');
      await page.locator('#admin-logout').click();
      await page.locator('#admin-login-form').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#admin-dashboard').isHidden(), true);
      assert.equal((await context.request.get(`${base}/api/admin/bookings`)).status(), 401);
      assert.equal((await fetch(`${base}/api/admin/session`, { headers: { Cookie: cookie } })).status, 401, 'Reusing the old cookie cannot recover a revoked server session');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.locator('#admin-login-form').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#admin-dashboard').isHidden(), true);
      assert.ok(!(await page.locator('body').innerText()).includes(fixtures[0].phone));
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({ path: join(output, `admin-login-${width}.png`), timeout: 30000 });
      }
    });
  } finally { await context.close(); }
});

test('expired session removes saved guest details and returns to the login page', async () => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  context.setDefaultTimeout(5000);
  const page = await context.newPage();
  try {
    await page.goto(`${base}/admin/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    assert.equal((await login(page)).status(), 200);
    await page.locator('#admin-results').filter({ hasText: ids[0] }).waitFor();
    now = new Date('2026-10-23T15:00:00Z');
    const response = waitList(page);
    await page.locator('#admin-refresh').click();
    assert.equal((await response).status(), 401);
    await page.locator('#admin-login-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#admin-dashboard').isHidden(), true);
    assert.equal((await page.locator('#admin-results').textContent()).trim(), '', 'Remove guest rows from DOM after session expiry');
    const html = await page.locator('body').innerHTML();
    for (const fixture of fixtures) assert.ok(!html.includes(fixture.phone) && !html.includes(fixture.name), 'Expired page contains no hidden guest names or phones');
    assert.equal((await context.request.get(`${base}/api/admin/session`)).status(), 401);
  } finally { now = new Date('2026-10-23T07:00:00Z'); await context.close(); }
});

test('a late initial session 401 cannot replace a login submitted during bootstrap', async () => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  context.setDefaultTimeout(5000);
  const page = await context.newPage();
  let release;
  try {
    const sessionUrl = `${base}/api/admin/session`;
    const gate = new Promise(resolve => { release = resolve; });
    let received;
    const held = new Promise(resolve => { received = resolve; });
    await page.route(sessionUrl, async route => {
      const response = await route.fetch();
      assert.equal(response.status(), 401);
      received();
      await gate;
      await route.fulfill({ response });
    });
    await page.goto(`${base}/admin/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await held;
    const successfulLogin = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/login');
    // Bootstrap normally keeps the form hidden. Submit the native form directly
    // to exercise the epoch guard if a login is initiated before bootstrap ends.
    await page.evaluate(({ username, password }) => {
      document.querySelector('#admin-username').value = username;
      document.querySelector('#admin-password').value = password;
      document.querySelector('#admin-login-form').requestSubmit();
    }, { username, password });
    assert.equal((await successfulLogin).status(), 200);
    await page.locator('#admin-results').filter({ hasText: ids[0] }).waitFor();
    const oldResponse = page.waitForResponse(response => response.url() === sessionUrl);
    release();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#admin-dashboard').isVisible(), true);
    assert.equal(await page.locator('#admin-login-form').isVisible(), false);
    assert.equal((await context.request.get(sessionUrl)).status(), 200);
    await page.locator('#admin-logout').click();
    await page.locator('#admin-login-form').waitFor({ state: 'visible' });
  } finally { release?.(); await context.close(); }
});

for (const delayedStatus of [401, 200]) {
  test(`a delayed detail ${delayedStatus} from the previous login cannot change the new session`, async () => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    context.setDefaultTimeout(5000);
    const page = await context.newPage();
    let release;
    try {
      const booking = await fetch(`${base}/api/bookings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `admin-race-fixture-${delayedStatus}` },
        body: JSON.stringify({ ...fixtures[0], name: `Гонка ${delayedStatus}`, time: '16:00' })
      });
      assert.equal(booking.status, 201);
      const id = (await booking.json()).id;
      await page.goto(`${base}/admin/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      assert.equal((await login(page)).status(), 200);
      await page.locator('#admin-results').filter({ hasText: id }).waitFor();
      const detailUrl = `${base}/api/admin/bookings/${id}`;
      const gate = new Promise(resolve => { release = resolve; });
      let received;
      const held = new Promise(resolve => { received = resolve; });
      await page.route(detailUrl, async route => {
        if (route.request().method() !== 'GET') { await route.continue(); return; }
        const response = await route.fetch();
        assert.equal(response.status(), 200, 'Original authenticated detail request reaches the real API');
        const detail = await response.json();
        received();
        await gate;
        await route.fulfill({ status: delayedStatus, contentType: 'application/json', body: JSON.stringify(delayedStatus === 200 ? detail : { message: 'Сеанс завершён. Войдите ещё раз.' }) });
      });
      await page.locator(`[data-admin-detail="${id}"]`).click();
      await held;
      await page.locator('#admin-logout').click();
      await page.locator('#admin-login-form').waitFor({ state: 'visible' });
      assert.equal((await login(page)).status(), 200);
      await page.locator('#admin-results').filter({ hasText: id }).waitFor();
      const oldResponse = page.waitForResponse(response => response.url() === detailUrl && response.request().method() === 'GET');
      release();
      await (await oldResponse).finished();
      // Let response.json and its UI continuation run before asserting absence.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#admin-dashboard').isVisible(), true, 'A stale response must not log out the newly authenticated screen');
      assert.equal(await page.locator('#admin-detail-dialog').isVisible(), false, 'A detail response from the old login must not reopen a dialog');
      assert.equal((await context.request.get(`${base}/api/admin/session`)).status(), 200);
      const patch = page.waitForResponse(response => response.url() === detailUrl && response.request().method() === 'PATCH');
      await action(page, id, 'confirmed').click();
      assert.equal((await patch).status(), 200, 'A stale 401 must not erase the new session CSRF token');
      assert.equal(dbStatus(id), 'confirmed');
      await page.locator('#admin-logout').click();
      await page.locator('#admin-login-form').waitFor({ state: 'visible' });
    } finally { release?.(); await context.close(); }
  });
}

test('password form can recover an incorrect current password and revokes the old login', async () => {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 1000 } });
  context.setDefaultTimeout(5000);
  const page = await context.newPage();
  const newPassword = 'Another-isolated-QA-password-67890';
  try {
    await page.goto(`${base}/admin/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    assert.equal((await login(page)).status(), 200);
    await page.locator('#admin-dashboard').waitFor({ state: 'visible' });
    await page.locator('#admin-password-open').click();
    await page.locator('#admin-password-dialog').waitFor({ state: 'visible' });
    await page.locator('#admin-current-password').fill('Wrong-current-QA-password');
    await page.locator('#admin-new-password').fill(newPassword);
    await page.locator('#admin-confirm-password').fill(newPassword);
    let pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/password');
    await page.locator('#admin-password-form button[type="submit"]').click();
    assert.equal((await pending).status(), 400);
    await page.locator('#admin-password-status').filter({ hasText: /\S/u }).waitFor();
    assert.equal(await page.locator('#admin-password-dialog').isVisible(), true);
    assert.equal((await context.request.get(`${base}/api/admin/session`)).status(), 200);
    await page.locator('#admin-current-password').fill(password);
    pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/password');
    await page.locator('#admin-password-form button[type="submit"]').click();
    assert.equal((await pending).status(), 200, 'Correct password retry retains the valid session CSRF token');
    await page.locator('#admin-login-form').waitFor({ state: 'visible' });
    assert.equal((await context.request.get(`${base}/api/admin/session`)).status(), 401);
    assert.equal((await login(page)).status(), 401, 'Old password was revoked');
    assert.equal((await login(page, newPassword)).status(), 200);
    await page.locator('#admin-dashboard').waitFor({ state: 'visible' });
    await page.locator('#admin-logout').click();
    await page.locator('#admin-login-form').waitFor({ state: 'visible' });
  } finally { await context.close(); }
});

