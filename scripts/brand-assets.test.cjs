/* eslint-disable @typescript-eslint/no-require-imports -- These tests exercise the CommonJS asset generator. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Buffer } = require('node:buffer');
const test = require('node:test');
const brand = require('./generate-brand.cjs');
const sharp = require(process.env.BRAND_SHARP_MODULE || 'sharp');
const read = file => fs.readFileSync(path.join(brand.root, file));

test('master preserves the six-part single-lens mark in a tight viewBox', () => {
  const mark = brand.readMaster();
  assert.equal(mark.viewBox, '140 135 974 650');
  assert.equal((mark.paths.match(/<path /g) || []).length, 6);
  assert.match(mark.paths, /A140 140/);
  assert.match(mark.paths, /A112 112/);
  assert.match(mark.paths, /A95 95/);
  assert.match(mark.svg, /fill-rule="evenodd"/);
  assert(!/<text|<image|<filter/.test(mark.svg));
});

test('lens gap and reflection remain transparent for CSS masks', async () => {
  const { data, info } = await sharp(read(brand.masterFile)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = (x, y) => data[((y - 135) * info.width + x - 140) * 4 + 3];
  assert.equal(info.width, 974);
  assert.equal(info.height, 650);
  assert.equal(alpha(627, 463), 255);
  assert.equal(alpha(731, 463), 0);
  assert.equal(alpha(755, 463), 255);
  assert.equal(alpha(605, 403), 0);
  assert.equal(alpha(627, 145), 255);
});

test('navigation SVG is exactly the authoritative master', () => {
  assert(read('public/zuychin-logo.svg').equals(read(brand.masterFile)));
});

test('favicon follows system colour scheme without a painted background', () => {
  const svg = read('public/favicon.svg').toString();
  assert.equal(svg, brand.themedSvg());
  assert.match(svg, /prefers-color-scheme:dark/);
  assert.match(svg, /#000000/);
  assert.match(svg, /#f8fafc/);
  assert(!svg.includes('<rect'));
});

test('launcher and Apple icons have exact dimensions and opaque backgrounds', async () => {
  for (const spec of brand.rasterSpecs.filter(spec => !spec.transparent)) {
    const { data, info } = await sharp(read(spec.file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, spec.size, spec.file);
    assert.equal(info.height, spec.size, spec.file);
    for (let i = 3; i < data.length; i += 4) assert.equal(data[i], 255, spec.file);
    assert.deepEqual([...data.subarray(0, 3)], [15, 23, 42], spec.file);
  }
});

test('maskable mark stays inside the central eighty-percent safe circle', async () => {
  const { data, info } = await sharp(read('public/icons/icon-maskable-512.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let ink = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * 4;
      if (data[offset] > 16 || data[offset + 1] > 24 || data[offset + 2] > 43) {
        ink++;
        assert(Math.hypot(x + 0.5 - 256, y + 0.5 - 256) <= 204.8, `Unsafe mark pixel ${x},${y}`);
      }
    }
  }
  assert(ink > 1000);
});

test('notification badge is white geometry on transparency', async () => {
  const { data, info } = await sharp(read('public/icons/badge-72.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 72);
  assert.equal(info.height, 72);
  let transparent = 0;
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) transparent++;
    else assert.deepEqual([...data.subarray(i, i + 3)], [255, 255, 255]);
    if (data[i + 3] === 255) opaque++;
  }
  assert(transparent > 2000 && opaque > 500);
});

test('Windows ICO has four valid independently decodable PNG frames', async () => {
  const ico = read('src-tauri/icons/icon.ico');
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 4);
  let expectedOffset = 70;
  for (const [index, size] of [16, 32, 48, 256].entries()) {
    const entry = 6 + index * 16;
    assert.equal(ico[entry] || 256, size);
    assert.equal(ico[entry + 1] || 256, size);
    assert.equal(ico.readUInt16LE(entry + 6), 32);
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(offset, expectedOffset);
    const metadata = await sharp(ico.subarray(offset, offset + length)).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
    expectedOffset += length;
  }
  assert.equal(expectedOffset, ico.length);
});

test('existing consumers reference generated assets and Apple metadata', () => {
  const layout = read('src/app/layout.tsx').toString();
  const worker = read('public/sw.js').toString();
  const manifest = read('src/app/manifest.ts').toString();
  const versioned = file => `/${file}?v=${createHash('sha256').update(read(`public/${file}`)).digest('hex').slice(0, 12)}`;
  assert(layout.includes(`icon: "${versioned('favicon.svg')}"`));
  assert(layout.includes(`apple: "${versioned('apple-touch-icon.png')}"`));
  assert(worker.includes(`icon: "${versioned('icons/icon-192.png')}"`));
  assert(worker.includes(`badge: "${versioned('icons/badge-72.png')}"`));
  for (const name of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) assert(manifest.includes(versioned(`icons/${name}`)));
  assert.match(manifest, /purpose: "maskable"/);
});

test('all nine generated assets reproduce exactly', async () => {
  const artifacts = await brand.generate(sharp);
  assert.equal(Object.keys(artifacts).length, 9);
  for (const [file, content] of Object.entries(artifacts)) assert(read(file).equals(Buffer.from(content)), file);
});
