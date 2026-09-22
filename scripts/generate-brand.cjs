/* eslint-disable @typescript-eslint/no-require-imports -- Asset generation uses explicitly supplied local tooling. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Buffer } = require('node:buffer');

const root = path.resolve(__dirname, '..');
const masterFile = 'public/zuychin-agent-master.svg';
const palette = { ink: '#000000', reversed: '#f8fafc', background: '#0f172a' };
const rasterSpecs = [
  { file: 'public/apple-touch-icon.png', size: 180, fraction: 0.84 },
  { file: 'public/icons/icon-192.png', size: 192, fraction: 0.84 },
  { file: 'public/icons/icon-512.png', size: 512, fraction: 0.84 },
  { file: 'public/icons/icon-maskable-512.png', size: 512, fraction: 0.66 },
  { file: 'public/icons/badge-72.png', size: 72, fraction: 0.9, transparent: true },
  { file: 'src-tauri/icons/icon.png', size: 512, fraction: 0.84 },
];

function readMaster() {
  const svg = fs.readFileSync(path.join(root, masterFile), 'utf8');
  assert(!/<(?:script|image|foreignObject|style)\b|\bon\w+\s*=|\bhref\s*=/i.test(svg), 'Master must be self-contained geometry');
  const viewBox = svg.match(/viewBox="([\d.\s]+)"/)?.[1];
  const box = viewBox?.split(/\s+/).map(Number);
  assert(box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0);
  const paths = [...svg.matchAll(/<path d="([MmLlHhVvCcSsQqTtAaZz\d\s.,+-]+)"\s*\/>/g)].map(match => match[0]);
  assert.equal(paths.length, 6, 'Approved mark has two rails, two sides and two lens paths');
  return { svg, viewBox, aspect: box[2] / box[3], paths: paths.join('') };
}

function themedSvg() {
  const mark = readMaster();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox}" fill-rule="evenodd"><style>path{fill:${palette.ink}}@media(prefers-color-scheme:dark){path{fill:${palette.reversed}}}</style>${mark.paths}</svg>\n`;
}

function squareSvg({ size, fraction, transparent = false }) {
  const mark = readMaster();
  const width = size * fraction;
  const height = width / mark.aspect;
  assert(size > 0 && fraction > 0 && fraction <= 1 && height <= size);
  const background = transparent ? '' : `<rect width="${size}" height="${size}" fill="${palette.background}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${background}<svg x="${(size - width) / 2}" y="${(size - height) / 2}" width="${width}" height="${height}" viewBox="${mark.viewBox}" fill="${transparent ? '#ffffff' : palette.reversed}" fill-rule="evenodd">${mark.paths}</svg></svg>\n`;
}

function packIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    assert([16, 32, 48, 256].includes(size));
    const entry = 6 + 16 * index;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(image => image.png)]);
}

function parseArgs(args) {
  let sharpModule;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check' && !check) check = true;
    else if (args[i] === '--sharp-module' && !sharpModule && args[i + 1] && !args[i + 1].startsWith('--')) sharpModule = path.resolve(args[++i]);
    else throw new Error('Usage: node scripts/generate-brand.cjs --sharp-module <installed Sharp path> [--check]');
  }
  assert(sharpModule, '--sharp-module is required; no dependencies are installed');
  return { sharpModule, check };
}

async function generate(sharp) {
  const artifacts = { 'public/zuychin-logo.svg': readMaster().svg, 'public/favicon.svg': themedSvg() };
  for (const spec of rasterSpecs) artifacts[spec.file] = await sharp(Buffer.from(squareSvg(spec))).png().toBuffer();
  const icoImages = [];
  for (const size of [16, 32, 48, 256]) {
    icoImages.push({ size, png: await sharp(Buffer.from(squareSvg({ size, fraction: 0.9 }))).png().toBuffer() });
  }
  artifacts['src-tauri/icons/icon.ico'] = packIco(icoImages);
  return artifacts;
}

async function main(args) {
  const { sharpModule, check } = parseArgs(args);
  const sharp = require(sharpModule);
  const artifacts = await generate(sharp);
  for (const [file, content] of Object.entries(artifacts)) {
    const target = path.join(root, file);
    if (check) assert(fs.readFileSync(target).equals(Buffer.from(content)), `Generated asset drift: ${file}`);
    else fs.writeFileSync(target, content);
  }
  console.log(JSON.stringify({ mode: check ? 'checked' : 'generated', master: masterFile, files: Object.keys(artifacts), sharp: sharp.versions.sharp }));
}

module.exports = { root, masterFile, palette, rasterSpecs, readMaster, themedSvg, squareSvg, packIco, parseArgs, generate };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
