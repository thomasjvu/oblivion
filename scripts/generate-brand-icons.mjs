#!/usr/bin/env node
/**
 * Generate optimized brand icons and favicons from public/assets/oblivion-agent-pfp.jpg
 * Run: node scripts/generate-brand-icons.mjs
 */
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'public/assets/oblivion-agent-pfp.jpg');
const sizes = [16, 32, 40, 48, 64, 80, 180, 192, 512];
const tmpDir = join(root, '.tmp-brand-icons');

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed`);
  }
}

mkdirSync(tmpDir, { recursive: true });
mkdirSync(join(root, 'public/assets/brand'), { recursive: true });
mkdirSync(join(root, 'public/favicon'), { recursive: true });
mkdirSync(join(root, 'docs/public/images/brand'), { recursive: true });
mkdirSync(join(root, 'docs/public/favicon'), { recursive: true });

for (const size of sizes) {
  const png = join(tmpDir, `icon-${size}.png`);
  run('sips', ['-z', String(size), String(size), source, '--out', png]);
  run('cwebp', ['-quiet', '-q', '82', png, '-o', join(tmpDir, `icon-${size}.webp`)]);
}

const copy = (from, to) => run('cp', [join(tmpDir, from), join(root, to)]);

copy('icon-32.webp', 'public/assets/brand/oblivion-agent-icon-32.webp');
copy('icon-32.png', 'public/assets/brand/oblivion-agent-icon-32.png');
copy('icon-40.webp', 'public/assets/brand/oblivion-agent-icon-40.webp');
copy('icon-40.png', 'public/assets/brand/oblivion-agent-icon-40.png');
copy('icon-48.webp', 'public/assets/brand/oblivion-agent-icon.webp');
copy('icon-48.png', 'public/assets/brand/oblivion-agent-icon.png');

for (const target of ['public/favicon', 'docs/public/favicon']) {
  copy('icon-16.png', `${target}/favicon-16x16.png`);
  copy('icon-32.png', `${target}/favicon-32x32.png`);
  copy('icon-180.png', `${target}/apple-touch-icon.png`);
  copy('icon-192.png', `${target}/android-chrome-192x192.png`);
  copy('icon-512.png', `${target}/android-chrome-512x512.png`);
  run('magick', [
    join(tmpDir, 'icon-16.png'),
    join(tmpDir, 'icon-32.png'),
    join(tmpDir, 'icon-48.png'),
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