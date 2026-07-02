#!/usr/bin/env node
// Renders Axion SVG logos to PNG icons for the Chrome extension.
// Run once from the extension/ directory: node make-icons.js
// Requires: ImageMagick (convert)

import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const complexSvg = resolve(__dirname, '../docs/logo.svg');
const smallSvg   = resolve(__dirname, '../docs/logo-small.svg');

const icons = [
  { size: 16,  svg: smallSvg },
  { size: 32,  svg: complexSvg },
  { size: 48,  svg: complexSvg },
  { size: 128, svg: complexSvg },
];

for (const { size, svg } of icons) {
  const out = resolve(__dirname, `icons/icon${size}.png`);
  execSync(
    `convert -density 384 -background none "${svg}" -resize ${size}x${size} "${out}"`,
    { stdio: 'inherit' }
  );
  console.log(`● icons/icon${size}.png`);
}
