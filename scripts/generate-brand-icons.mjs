#!/usr/bin/env node
/**
 * Generate optimized brand icons and favicons from the 1-bit agent PFP.
 * Run: npm run generate:brand-icons
 */
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'public/assets/oblivion-agent-pfp-onebit.jpg');
const brandSizes = [32, 40, 48, 64, 80, 180, 192, 512];
const faviconSizes = [16, 32, 48];
const tmpDir = join(root, '.tmp-brand-icons');

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed`);
  }
}

function resizeIcon(size, outPath, { favicon = false } = {}) {
  const args = [source];
  if (favicon) {
    // Tighter crop so the face reads at 16–32px tab sizes.
    args.push('-gravity', 'center', '-crop', '74%x74%+0+0', '+repage');
  }
  args.push(
    '-filter',
    'Point',
    '-resize',
    `${size}x${size}!`,
    '-strip',
    outPath
  );
  run('magick', args);
}

function toWebp(pngPath, webpPath) {
  run('cwebp', ['-quiet', '-lossless', pngPath, '-o', webpPath]);
}

mkdirSync(tmpDir, { recursive: true });
mkdirSync(join(root, 'public/assets/brand'), { recursive: true });
mkdirSync(join(root, 'public/favicon'), { recursive: true });
mkdirSync(join(root, 'docs/public/images/brand'), { recursive: true });
mkdirSync(join(root, 'docs/public/favicon'), { recursive: true });

for (const size of brandSizes) {
  const png = join(tmpDir, `icon-${size}.png`);
  resizeIcon(size, png);
  toWebp(png, join(tmpDir, `icon-${size}.webp`));
}

for (const size of faviconSizes) {
  resizeIcon(size, join(tmpDir, `favicon-${size}.png`), { favicon: true });
}

const copy = (from, to) => run('cp', [join(tmpDir, from), join(root, to)]);

copy('icon-32.webp', 'public/assets/brand/oblivion-agent-icon-32.webp');
copy('icon-32.png', 'public/assets/brand/oblivion-agent-icon-32.png');
copy('icon-40.webp', 'public/assets/brand/oblivion-agent-icon-40.webp');
copy('icon-40.png', 'public/assets/brand/oblivion-agent-icon-40.png');
copy('icon-48.webp', 'public/assets/brand/oblivion-agent-icon.webp');
copy('icon-48.png', 'public/assets/brand/oblivion-agent-icon.png');

for (const target of ['public/favicon', 'docs/public/favicon']) {
  copy('favicon-16.png', `${target}/favicon-16x16.png`);
  copy('favicon-32.png', `${target}/favicon-32x32.png`);
  copy('icon-180.png', `${target}/apple-touch-icon.png`);
  copy('icon-192.png', `${target}/android-chrome-192x192.png`);
  copy('icon-512.png', `${target}/android-chrome-512x512.png`);
  run('magick', [
    join(tmpDir, 'favicon-16.png'),
    join(tmpDir, 'favicon-32.png'),
    join(tmpDir, 'favicon-48.png'),
    join(root, target, 'favicon.ico'),
  ]);
}

copy('icon-32.webp', 'docs/public/images/brand/oblivion-agent-icon-32.webp');
copy('icon-32.png', 'docs/public/images/brand/oblivion-agent-icon-32.png');
copy('icon-40.webp', 'docs/public/images/brand/oblivion-agent-icon-40.webp');
copy('icon-40.png', 'docs/public/images/brand/oblivion-agent-icon-40.png');
copy('icon-80.webp', 'docs/public/images/brand/oblivion-agent-icon-80.webp');
copy('icon-80.png', 'docs/public/images/brand/oblivion-agent-icon-80.png');

console.log('Brand icons generated from', source);