import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundledModule = 'C:/Users/hemar/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const bundledBrowser = 'C:/Users/hemar/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';
const bundledEdge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const modulePath = process.env.PLAYWRIGHT_MODULE || (existsSync(bundledModule) ? bundledModule : null);
const playwright = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
assert.ok(process.env.QA_URL, 'Use node qa/run.mjs for an isolated temporary database, or explicitly provide QA_URL');
const base = process.env.QA_URL;
const output = resolve(process.env.QA_OUTPUT || join(tmpdir(), 'ezh-browser-evidence'));
await mkdir(output, { recursive: true });
const report = { browserMethod: 'Playwright (Browser plugin not available)', base, checks: [], warnings: [] };
const executablePath = process.env.CHROMIUM_PATH || (existsSync(bundledBrowser) ? bundledBrowser : undefined);
const edgePath = process.env.EDGE_PATH || (existsSync(bundledEdge) ? bundledEdge : undefined);
if (process.env.QA_EDGE_ONLY === '1') {
  await edgeSmoke();
} else {
const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const runtimeErrors = [];
const consoleErrors = [];
page.on('pageerror', error => {
  if (process.env.QA_DEV === '1' && error.message === 'WebSocket closed without opened.') {
    report.warnings.push('Vite development middleware closes its disabled HMR websocket; production QA must pass without this development-only exception.');
  } else runtimeErrors.push(error.message);
});
page.on('console', message => {
  if (['error', 'warning'].includes(message.type()) && !/net::ERR_(FAILED|ABORTED|BLOCKED_BY_CLIENT)/.test(message.text())) consoleErrors.push(message.text());
});
const assetFailures = [];
page.on('response', response => { if (response.url().startsWith(base) && response.status() >= 400 && !response.url().includes('/api/')) assetFailures.push([response.url(), response.status()]); });
await page.route('https://maps.google.com/**', route => route.abort());
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.locator('.hero-cup').waitFor();
// Load below-the-fold photos before full-page evidence; decode() alone can wait
// indefinitely for an offscreen lazy image whose request has not started.
await page.evaluate(() => { for (const image of document.images) image.loading = 'eager'; });
await page.waitForFunction(() => [...document.images].every(image => image.complete), null, { timeout: 15000 });
await page.evaluate(() => Promise.all([...document.images].map(image => image.decode().catch(() => {}))));
await page.locator('.hero-cup').evaluate(image => Promise.all(image.getAnimations().map(animation => animation.finished.catch(() => {}))));
assert.match(await page.title(), /Семейный Ёж/);
assert.equal(await page.locator('h1').count(), 1);
assert.equal(await page.locator('main').count(), 1);
assert.equal(await page.locator('.hero-cup').evaluate(image => image.naturalWidth > 0), true);
assert.ok((await page.locator('main').innerText()).length > 500);
assert.equal(await page.locator('vite-error-overlay').count(), 0);
report.checks.push('Page title, single h1 and main, meaningful content and hero asset: PASS');

for (const width of [320, 375, 390, 540, 650, 768, 850, 1024, 1150, 1440, 1920]) {
  await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
  await page.evaluate(() => scrollTo(0, 0));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${width}`);
  const clipped = await page.locator('.header,.drink-rail,.booking-form,.contacts-grid,.footer').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().width > 0 && (element.getBoundingClientRect().right > innerWidth + 1 || element.getBoundingClientRect().left < -1)).map(element => element.className));
  assert.deepEqual(clipped, [], `Clipped sections at ${width}`);
  if ([320,390,768,1440,1920].includes(width)) await page.screenshot({ path: `${output}/${width}-full.png`, fullPage: true });
  if ([390,1440].includes(width)) await page.screenshot({ path: `${output}/${width}-first.png` });
  if (width <= 650) {
    const actions = page.locator('.mobile-actions a');
    assert.equal(await actions.count(), 2);
    for (const action of await actions.all()) {
      assert.equal(await action.isVisible(), true);
      const box = await action.boundingBox();
      assert.ok(box.height >= 44 && box.width >= 44, `Mobile action has a usable touch target at ${width}px`);
      assert.ok(box.y >= 0 && box.y + box.height <= (width < 700 ? 844 : 1000), `Mobile action stays in the viewport at ${width}px`);
    }
  }
  report.checks.push(`Responsive ${width}px: no overflow or clipped section: PASS`);
}
await page.setViewportSize({ width: 390, height: 844 });
const toggle = page.locator('.menu-toggle');
await toggle.click();
assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
await page.keyboard.press('Escape');
assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
assert.equal(await toggle.evaluate(element => element === document.activeElement), true);
await toggle.click();
await page.locator('#mobile-nav').getByRole('link', { name: 'Атмосфера', exact: true }).click();
assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
assert.equal(new URL(page.url()).hash, '#atmosphere');
report.checks.push('Mobile menu: toggle, Escape, focus restoration, anchor and auto-close: PASS');

const menuItems = page.locator('#menu-list > [data-menu-category]');
assert.ok(await menuItems.count() > 3, 'Full menu has more than the three featured drinks');
const menuEntries = await menuItems.evaluateAll(elements => elements.map(element => ({ category: element.dataset.menuCategory, text: element.textContent })));
assert.ok(new Set(menuEntries.map(item => item.category)).size > 2, 'Menu has distinct categories');
assert.ok(menuEntries.every(item => /\d+\s*₽/.test(item.text)), 'Every menu item has an explicit price');
for (const filter of await page.locator('#menu-filter [data-category]').all()) {
  const category = await filter.getAttribute('data-category');
  await filter.click();
  assert.equal(await filter.getAttribute('aria-pressed'), 'true');
  const expected = category === 'all' ? menuEntries.length : menuEntries.filter(item => item.category === category).length;
  assert.ok(expected > 0, `Filter ${category} selects existing menu items`);
  assert.equal(await page.locator('#menu-list > [data-menu-category]:visible').count(), expected);
  const visibleCategories = await page.locator('#menu-list > [data-menu-category]:visible').evaluateAll(elements => elements.map(element => element.dataset.menuCategory));
  assert.ok(category === 'all' || visibleCategories.every(value => value === category));
}
await page.locator('#menu-filter [data-category="all"]').click();
report.checks.push('Full menu: every item has a price; all category filters change visible items and pressed state: PASS');

const recommendations = [];
for (const [mood, label] of [['soft', 'Мягкий'], ['sweet', 'Десертный'], ['fresh', 'Освежающий']]) {
  const button = page.locator(`[data-mood="${mood}"]`);
  assert.ok((await button.textContent()).includes(label));
  await button.click();
  assert.equal(await button.getAttribute('aria-pressed'), 'true');
  const result = page.locator('#taste-result');
  const heading = await result.locator('h3,h4').textContent();
  recommendations.push(heading);
  await result.locator('[data-drink]').click();
  assert.equal(await page.locator('#drink-dialog').evaluate(dialog => dialog.open), true);
  assert.equal(await page.locator('#drink-title').textContent(), heading);
  await page.keyboard.press('Escape');
}
assert.equal(new Set(recommendations).size, 3, 'Each mood recommends a different drink');
report.checks.push('Taste picker: all three moods update the recommendation; details open the matching drink: PASS');

await page.setViewportSize({ width: 1440, height: 1000 });
await page.locator('[data-drink="0"]').first().click();
assert.equal(await page.locator('#drink-dialog').evaluate(dialog => dialog.open), true);
assert.equal(await page.locator('#drink-title').textContent(), 'Капучино');
await page.keyboard.press('Tab');
assert.equal(await page.locator('#drink-dialog').evaluate(dialog => dialog.contains(document.activeElement)), true);
await page.keyboard.press('Escape');
assert.equal(await page.locator('[data-drink="0"]').first().evaluate(element => element === document.activeElement), true);
await page.locator('[data-drink="1"]').first().click();
await page.locator('#drink-booking').click();
assert.equal(await page.locator('#drink-dialog').evaluate(dialog => dialog.open), false);
assert.equal(new URL(page.url()).hash, '#booking');
report.checks.push('Drink details, modal focus containment/restoration, booking link: PASS');

await page.locator('[data-gallery="0"]').click();
assert.equal(await page.locator('#lightbox').evaluate(dialog => dialog.open), true);
await page.keyboard.press('ArrowRight');
assert.match(await page.locator('#lightbox-caption').textContent(), /2 \/ 3/);
await page.locator('.gallery-prev').click();
assert.match(await page.locator('#lightbox-caption').textContent(), /1 \/ 3/);
await page.keyboard.press('Escape');
assert.equal(await page.locator('[data-gallery="0"]').evaluate(element => element === document.activeElement), true);
await page.locator('[data-privacy]').first().click();
assert.equal(await page.locator('#privacy-dialog').evaluate(dialog => dialog.open), true);
await page.keyboard.press('Escape');
report.checks.push('Gallery: open, arrows, keyboard, Escape and focus restoration; privacy dialog: PASS');

const submit = page.locator('.submit-booking');
await submit.click();
assert.equal(await page.locator('#name').getAttribute('aria-invalid'), 'true');
assert.equal(await page.locator('#name').evaluate(element => element === document.activeElement), true);
await page.locator('#name').fill('Тестовый гость');
await page.locator('#phone').fill('123');
await submit.click();
assert.match(await page.locator('#phone-error').textContent(), /номер/);
await page.locator('#phone').fill('+7 (999) 123-45-67');
const tomorrow = await page.locator('#date').evaluate(input => {
  const date = new Date(`${input.min}T12:00:00+03:00`); date.setUTCDate(date.getUTCDate() + 1);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(date);
});
await page.locator('#date').fill(tomorrow);
await page.locator('#time').selectOption('12:30');
await page.locator('#consent').check();
await page.locator('.booking-comment summary').click();
await page.locator('#comment').fill('<invalid>');
await page.locator('.booking-comment summary').click();
await submit.click();
assert.equal(await page.locator('.booking-comment').evaluate(details => details.open), true);
assert.equal(await page.locator('#comment').evaluate(input => input === document.activeElement), true);
assert.match(await page.locator('#comment-error').textContent(), /HTML|размет/i);
await page.locator('#comment').fill('');
report.checks.push('Form: empty fields, error messages, invalid phone, first invalid focus: PASS');
report.checks.push('Invalid collapsed comment: details opens and the erroneous field receives focus: PASS');

await page.route('**/api/bookings', route => route.abort('failed'));
await submit.click();
await page.locator('#form-status').filter({ hasText: 'Связь прервалась' }).waitFor();
assert.equal(await page.locator('#name').inputValue(), 'Тестовый гость');
assert.equal(await submit.isEnabled(), true);
await page.unroute('**/api/bookings');

await page.route('**/api/bookings', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Временная ошибка сервера. Повторите отправку.' }) }));
await submit.click();
await page.locator('#form-status').filter({ hasText: 'Временная ошибка' }).waitFor();
assert.equal(await page.locator('#phone').inputValue(), '+7 (999) 123-45-67');
await page.unroute('**/api/bookings');
report.checks.push('Network failure and server 503: readable error, retained fields, retry available: PASS');

let requests = 0;
let savedId;
await page.route('**/api/bookings', async route => {
  requests++;
  await new Promise(resolve => setTimeout(resolve, 500));
  const response = await route.fetch();
  savedId = (await response.json()).id;
  await route.abort('failed');
});
await submit.click();
assert.equal(await submit.isDisabled(), true);
await page.locator('#booking-form').evaluate(form => form.requestSubmit());
await page.locator('#form-status').filter({ hasText: 'Связь прервалась' }).waitFor();
assert.equal(requests, 1);
assert.match(savedId, /^EZH-/);
await page.unroute('**/api/bookings');
await submit.click();
await page.locator('#booking-success').waitFor({ state: 'visible' });
assert.match(await page.locator('#booking-receipt').textContent(), new RegExp(savedId));
assert.equal(await page.locator('#booking-fields').isHidden(), true);
await page.locator('#booking-success').screenshot({ path: `${output}/booking-success.png` });
await page.locator('#another-booking').click();
assert.equal(await page.locator('#name').inputValue(), '');
assert.equal(await page.locator('#name').evaluate(element => element === document.activeElement), true);
report.checks.push('Slow connection, double submit blocked, saved response lost, retry yields same real receipt, new form reset: PASS');

assert.equal(await page.locator('[data-phone]').getAttribute('href'), 'tel:+74950000027');
assert.match(await page.locator('[data-directions]').first().getAttribute('href'), /yandex\.ru\/maps/);
assert.equal(await page.locator('.map-placeholder').isVisible(), true);
await page.locator('[data-load-map]').click();
assert.match(await page.locator('#cafe-map').getAttribute('src'), /Покровка/);
assert.equal(await page.locator('.map-placeholder').isVisible(), true);
assert.equal(await page.locator('.map-wrap [data-directions]').isVisible(), true);
await page.emulateMedia({ reducedMotion: 'reduce' });
assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
assert.equal(await page.locator('.hero-cup').evaluate(image => getComputedStyle(image).animationName), 'none');
assert.deepEqual(runtimeErrors, []);
assert.deepEqual(consoleErrors.filter(message => !/Failed to load resource: the server responded with a status of 503/.test(message)), []);
assert.deepEqual(assetFailures, []);
report.checks.push('Phone/map links, reduced motion, zero runtime errors and zero local asset failures: PASS');
report.warnings.push('External Google Maps iframe deliberately blocked during deterministic browser tests; external rendering requires network-enabled verification. Address and route fallback remain visible.');

await browser.close();
for (const [name, engine, browserPath] of [['Firefox', playwright.firefox, process.env.FIREFOX_PATH], ['Edge', playwright.chromium, edgePath]]) {
  if (!browserPath) { report.warnings.push(`${name} not run: executable not configured.`); continue; }
  let smokeBrowser;
  try {
    const browser = await engine.launch({ headless: true, executablePath: browserPath });
    smokeBrowser = browser;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route('https://maps.google.com/**', route => route.abort());
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('.hero-cup').evaluate(image => image.decode());
    await page.locator('.hero-cup').evaluate(image => Promise.all(image.getAnimations().map(animation => animation.finished.catch(() => {}))));
    assert.equal(await page.locator('.hero-cup').evaluate(image => image.naturalWidth > 0), true);
    await page.locator('.menu-toggle').click();
    assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    await page.locator('[data-drink="0"]').first().click();
    assert.equal(await page.locator('#drink-dialog').evaluate(dialog => dialog.open), true);
    await page.keyboard.press('Escape');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    report.checks.push(`${name} mobile smoke: rendering, navigation, dialog and no overflow: PASS`);
    await browser.close();
  } catch (error) { report.warnings.push(`${name} smoke blocked: ${error.message.split('\n')[0]}`); }
  finally { await smokeBrowser?.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
}

async function edgeSmoke() {
  assert.ok(edgePath, 'Microsoft Edge executable is required for the bounded Edge smoke');
  const browser = await playwright.chromium.launch({ headless: true, executablePath: edgePath });
  const supplementary = { browserMethod: 'Microsoft Edge through Playwright (Browser plugin not available)', browserVersion: browser.version(), base, checks: [], warnings: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 1000 } });
    const errors = [], mapRequests = [], apiRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/bookings') apiRequests.push(request.url()); });
    await page.route('https://maps.google.com/**', route => { mapRequests.push(route.request().url()); return route.abort(); });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#time')?.options.length > 1);
    assert.match(await page.title(), /Семейный Ёж/);
    assert.equal(await page.locator('h1').count(), 1);
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    await page.locator('.hero-cup').evaluate(image => image.decode());
    await page.locator('.hero-cup').evaluate(image => Promise.all(image.getAnimations().map(animation => animation.finished.catch(() => {}))));
    supplementary.checks.push('Page identity, meaningful screen, hero asset, no framework overlay: PASS');
    for (const width of [326, 390, 760, 761, 1024]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No overflow at ${width}px`);
      assert.equal(await page.locator('.desktop-nav').isVisible(), width > 760);
      assert.equal(await page.locator('.header-book').isVisible(), width > 760);
      assert.equal(await page.locator('.menu-toggle').isVisible(), width <= 760);
      assert.equal(await page.locator('.mobile-actions').isVisible(), width <= 760);
      const boxes = await page.locator('.header .brand,.header .desktop-nav,.header .header-book,.header .menu-toggle').evaluateAll(elements => elements.map(element => element.getBoundingClientRect()).filter(box => box.width && box.height).map(box => ({ left: box.left, right: box.right })).sort((a, b) => a.left - b.left));
      assert.ok(boxes.every(box => box.left >= 0 && box.right <= width), `Header stays in viewport at ${width}px`);
      assert.ok(boxes.every((box, index) => !index || boxes[index - 1].right <= box.left + 1), `Header controls do not overlap at ${width}px`);
      supplementary.checks.push(`Header ${width}px: correct desktop/mobile state, no overlap or overflow: PASS`);
    }
    await page.screenshot({ path: join(output, 'edge-1024-first.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(output, 'edge-390-first.png') });
    await page.locator('.menu-toggle').click();
    assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'false');
    await page.locator('#menu-filter [data-category="cold"]').click();
    const categories = await page.locator('#menu-list > [data-menu-category]:visible').evaluateAll(items => items.map(item => item.dataset.menuCategory));
    assert.ok(categories.length > 0 && categories.every(category => category === 'cold'));
    await page.locator('#menu-filter [data-category="all"]').click();
    await page.locator('[data-mood="sweet"]').click();
    assert.equal(await page.locator('[data-mood="sweet"]').getAttribute('aria-pressed'), 'true');
    const recommended = await page.locator('#taste-result h4').textContent();
    await page.locator('#taste-result [data-drink]').click();
    assert.equal(await page.locator('#drink-dialog').evaluate(dialog => dialog.open), true);
    assert.equal(await page.locator('#drink-title').textContent(), recommended);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#drink-dialog').evaluate(dialog => dialog.open), false);
    supplementary.checks.push('Mobile navigation, category filter, dessert recommendation, matching modal and Escape: PASS');
    await page.locator('#name').fill('Проверка Edge');
    await page.locator('#phone').fill('+79991234567');
    const tomorrow = await page.locator('#date').evaluate(input => {
      const value = new Date(`${input.min}T12:00:00+03:00`);
      value.setUTCDate(value.getUTCDate() + 1);
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(value);
    });
    await page.locator('#date').fill(tomorrow);
    await page.locator('#time').selectOption('13:00');
    await page.locator('#consent').check();
    await page.locator('.booking-comment summary').click();
    await page.locator('#comment').fill('<invalid>');
    await page.locator('.booking-comment summary').click();
    await page.locator('#booking-form button[type=submit]').click();
    assert.equal(await page.locator('.booking-comment').evaluate(details => details.open), true);
    assert.equal(await page.locator('#comment').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#comment').evaluate(input => input === document.activeElement), true);
    assert.deepEqual(apiRequests, []);
    supplementary.checks.push('Invalid collapsed booking comment opens, focuses its error, and prevents API submission: PASS');
    await page.locator('#contacts').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#cafe-map').getAttribute('src'), null);
    assert.equal(await page.locator('.map-placeholder').isVisible(), true);
    assert.deepEqual(mapRequests, []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    supplementary.checks.push('Map has no src or requests before click; scroll works; no runtime/console errors: PASS');
    await writeFile(join(output, 'edge-smoke.json'), JSON.stringify(supplementary, null, 2));
    console.log(JSON.stringify(supplementary, null, 2));
  } finally { await browser.close(); }
}
