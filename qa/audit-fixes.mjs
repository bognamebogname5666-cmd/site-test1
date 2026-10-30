import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after, before } from 'node:test';
import { createApp } from '../server/index.mjs';

// Browser plugin not available; the installed Playwright runs a private app.
// Regressions: replacing a visible label with an incomplete aria-label, and
// reporting every category count with the incorrect fixed ending "напитка".
const bundledModule = 'C:/Users/hemar/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const bundledBrowser = 'C:/Users/hemar/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';
const axePath = process.env.AXE_PATH || 'C:/Users/hemar/.codex/visualizations/2026/10/20/01a15a2f-c024-7230-980f-084caa1a02ac/fresh-independent-tools/package/axe.min.js';
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : existsSync(bundledModule) ? pathToFileURL(bundledModule).href : 'playwright');
let app, browser, context, page, directory, base, output;
const pageErrors = [];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ezh-audit-qa-data-'));
  output = process.env.QA_OUTPUT || await mkdtemp(join(tmpdir(), 'ezh-audit-qa-evidence-'));
  await mkdir(output, { recursive: true });
  app = await createApp({ databasePath: join(directory, 'test.sqlite'), telegram: null, dev: process.env.QA_BUILT === '0', hmr: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const executablePath = process.env.CHROMIUM_PATH || (existsSync(bundledBrowser) ? bundledBrowser : undefined);
  browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(5000);
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('.taste-details').waitFor();
  console.log(`Audit QA: ${base}; screenshots: ${output}`);
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
    assert.ok(isAbsolute(target) && target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith('ezh-audit-qa-data-'));
    await rm(target, { recursive: true, force: true });
  }
});

test('header brand accessible name includes its visible coffee shop subtitle', async () => {
  const brand = page.locator('.header .brand');
  assert.equal(await page.getByRole('link', { name: /семейный ёж.*кофейня рядом/i }).and(brand).count(), 1, await brand.ariaSnapshot());
});

test('taste recommendation accessible name includes its visible price and volume', async () => {
  for (const mood of ['soft', 'sweet', 'fresh']) {
    await page.locator(`[data-mood="${mood}"]`).click();
    const button = page.locator('.taste-details');
    const visible = (await button.innerText()).replace(/[↗·]/gu, '').trim().split(/\s+/u);
    const name = new RegExp(visible.map(word => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*'), 'iu');
    assert.equal(await page.getByRole('button', { name }).and(button).count(), 1, `Visible: ${visible.join(' ')}; accessible: ${await button.ariaSnapshot()}`);
  }
});

for (const [index, caption] of [[0, 'Ваш маленький перерыв'], [1, 'С любовью, в каждой чашке']]) {
  test(`gallery ${index + 1} accessible name includes visible caption`, async () => {
    const button = page.locator(`[data-gallery="${index}"]`);
    assert.equal(await page.getByRole('button', { name: new RegExp(caption, 'iu') }).and(button).count(), 1, await button.ariaSnapshot());
  });
}

test('all five menu categories announce a neutral count matching the visible drinks', async () => {
  for (const category of ['all', 'coffee', 'signature', 'cold', 'no-coffee']) {
    await page.locator(`[data-category="${category}"]`).click();
    const count = await page.locator('[data-menu-category]:visible').count();
    const announcement = await page.locator('#menu-count').innerText();
    assert.match(announcement, new RegExp(`Количество напитков: ${count}(?:\\D|$)`, 'u'), `${category}: ${announcement}`);
  }
});

test('axe finds no label-content-name-mismatch in the four corrected controls', async t => {
  if (!existsSync(axePath)) { t.skip('AXE_PATH unavailable; computed accessible-name assertions above remain mandatory'); return; }
  await page.evaluate(await readFile(axePath, 'utf8'));
  const results = await page.evaluate(async () => window.axe.run(document, { runOnly: ['label-content-name-mismatch'] }));
  assert.deepEqual(results.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })), []);
});

test('corrected public page retains desktop and mobile layout without overflow', async () => {
  assert.match(await page.title(), /Семейный Ёж/u);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.deepEqual(pageErrors, []);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px horizontal overflow`);
    await page.screenshot({ path: join(output, `audit-public-${width}.png`), fullPage: true, timeout: 30000 });
  }
});
