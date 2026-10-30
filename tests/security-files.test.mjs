import test from 'node:test';
import assert from 'node:assert/strict';
import { symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { securityFixture, assertPrivate } from './helpers/security-fixture.mjs';

test('private credentials resist alternate URL representations before Vite reads them', async t => {
  const { get, databasePath } = await securityFixture(t);
  const absolute = databasePath.replaceAll('\\', '/').replace(/bookings\.bin$/, 'admin-access.txt');
  const paths = [
    '/private/admin-access.txt', '/private%5cadmin-access.txt', '/private%255cadmin-access.txt',
    '/private%2fadmin-access.txt', '/private%5c..%5cprivate%5cadmin-access.txt',
    '/private/ADMIN-ACCESS.TXT', '/private/admin-access.txt.', '/private/admin-access.txt%20',
    '/private/admin-access.txt::$DATA', `/@fs/${absolute}`, `/@fs/${absolute.replace('/admin-access.txt', '%5cadmin-access.txt')}`,
    `/@id/${absolute}`, `/@id/${absolute.replace('/admin-access.txt', '%5cadmin-access.txt')}`
  ];
  for (const path of paths) for (const query of ['', '?raw', '?raw&import', '?url']) {
    assertPrivate(await get(path + query), path + query);
  }
  assertPrivate(await get('/private%5cadmin-access.txt', 'HEAD'), 'HEAD private credentials');
  for (const path of ['/', '/admin/', '/src/main.ts', '/shared/config.json', '/@vite/client', '/images/safe.svg', '/api/health']) {
    const response = await get(path);
    assert.equal(response.status, 200, `Legitimate dev route ${path}: ${response.body.toString('utf8')}`);
  }
});

test('configured databases and sidecars stay private through Vite public mappings', async t => {
  const { get } = await securityFixture(t, { databaseName: 'public/bookings.bin' });
  for (const suffix of ['', '-wal', '-shm']) for (const query of ['', '?raw', '?url']) {
    assertPrivate(await get(`/bookings.bin${suffix}${query}`), `public database ${suffix}${query}`);
  }
});

test('configured databases and sidecars stay private through production asset mappings', async t => {
  const { get } = await securityFixture(t, { dev: false, databaseName: 'dist/assets/bookings.bin' });
  for (const suffix of ['', '-wal', '-shm']) assertPrivate(await get(`/assets/bookings.bin${suffix}`), `production database ${suffix}`);
  assertPrivate(await get('/assets/bookings.bin', 'HEAD'), 'HEAD production database');
  assert.equal((await get('/assets/safe.js')).status, 200);
  assert.equal((await get('/admin/')).status, 200);
});

test('directory aliases cannot expose the protected credential file or database', async t => {
  const { root, get } = await securityFixture(t);
  await symlink(join(root, 'private'), join(root, 'public', 'innocent'), 'junction');
  for (const path of ['/innocent/admin-access.txt', '/innocent/bookings.bin', '/innocent/bookings.bin-wal', '/innocent/bookings.bin-shm']) {
    assertPrivate(await get(path), path);
    assertPrivate(await get(path + '?raw'), path + '?raw');
  }
  assert.equal((await get('/images/safe.svg')).status, 200);
});

test('Vite HTML rewrites cannot expose configured databases through shortened URLs', async t => {
  for (const [databaseName, alias] of [['private/index.html', '/private/'], ['private/cafe.html', '/private/cafe']]) {
    const { get } = await securityFixture(t, { databaseName });
    assertPrivate(await get(alias), alias);
    assertPrivate(await get(alias + '?visit=1'), alias + '?visit=1');
    assertPrivate(await get(alias, 'HEAD'), `HEAD ${alias}`);
    const response = await get('/admin/');
    assert.equal(response.status, 200, `Legitimate dev admin page: ${response.body.toString('utf8')}`);
  }
});

test('production hardlink aliases cannot expose the same database or credential file', async t => {
  const { root, databasePath, get } = await securityFixture(t, { dev: false });
  await link(databasePath, join(root, 'dist/assets/innocent.bin'));
  await link(join(root, 'private/admin-access.txt'), join(root, 'dist/assets/welcome.txt'));
  for (const path of ['/assets/innocent.bin', '/assets/welcome.txt']) {
    assertPrivate(await get(path), path);
    assertPrivate(await get(path, 'HEAD'), `HEAD ${path}`);
  }
  assert.equal((await get('/assets/safe.js')).status, 200);
});

test('custom error pages cannot expose a configured database used as the 404 template', async t => {
  const { get } = await securityFixture(t, { dev: false, databaseName: 'dist/404.html' });
  assertPrivate(await get('/unknown-page'), '404 template database');
});
