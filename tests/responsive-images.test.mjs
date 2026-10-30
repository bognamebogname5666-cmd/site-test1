import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { renderFeatured } from '../build/catalog.mjs';
import { responsiveImage } from '../shared/responsive-images.mjs';

async function actualWebpWidth(url) {
  const data = await readFile(new URL(`../public${url}`, import.meta.url));
  assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(data.toString('ascii', 8, 12), 'WEBP');
  for (let offset = 12; offset + 8 <= data.length;) {
    const kind = data.toString('ascii', offset, offset + 4);
    if (kind === 'VP8X') return data.readUIntLE(offset + 12, 3) + 1;
    if (kind === 'VP8 ') return data.readUInt16LE(offset + 14) & 0x3fff;
    const length = data.readUInt32LE(offset + 4);
    offset += 8 + length + length % 2;
  }
  throw new Error(`No supported WebP dimensions found: ${url}`);
}

test('featured cards offer smaller real image resources for mobile thumbnails', async () => {
  const images = [...renderFeatured().matchAll(/<img\b[^>]*>/g)].map(match => match[0]);
  assert.equal(images.length, 3);
  for (const image of images) {
    const srcset = image.match(/srcset="([^"]+)"/)?.[1];
    assert.ok(srcset, `Featured image needs responsive candidates: ${image}`);
    const candidates = srcset.split(',').map(candidate => candidate.trim().split(/\s+/));
    assert.ok(candidates.some(([, width]) => width === '192w'), 'Mobile thumbnail candidate is available');
    assert.ok(candidates.some(([, width]) => width === '640w'), 'Original remains available for high density');
    assert.match(image, /sizes="[^\"]*86px/);
    for (const [url, width] of candidates) {
      await access(new URL(`../public${url}`, import.meta.url));
      assert.equal(await actualWebpWidth(url), Number.parseInt(width, 10), 'Descriptor matches real image width');
    }
  }
});

test('unknown catalog images retain their original URL without unavailable variants', () => {
  assert.deepEqual(responsiveImage('/images/future-seasonal.webp', '86px'), {
    src: '/images/future-seasonal.webp', srcset: '', sizes: ''
  });
  assert.deepEqual(responsiveImage('https://example.test/drink.webp', '86px'), {
    src: 'https://example.test/drink.webp', srcset: '', sizes: ''
  });
  assert.equal(responsiveImage('toString', '86px').srcset, '');
});

test('hero and gallery responsive candidates include their originals and real files', async () => {
  for (const [source, originalWidth] of [['/images/coffee-hero.webp', 800], ['/images/cafe-interior.webp', 1440]]) {
    const image = responsiveImage(source, '50vw');
    assert.equal(image.src, source);
    assert.equal(image.sizes, '50vw');
    assert.ok(image.srcset.endsWith(`${source} ${originalWidth}w`));
    for (const candidate of image.srcset.split(', ')) {
      const [url, width] = candidate.split(' ');
      await access(new URL(`../public${url}`, import.meta.url));
      assert.equal(await actualWebpWidth(url), Number.parseInt(width, 10));
    }
  }
});
