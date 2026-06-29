#!/usr/bin/env node
// Compile each test file with esbuild (handles JSX + ESM), then run via node --test.
import { build } from 'esbuild';
import { spawnSync } from 'child_process';
import { readdirSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

mkdirSync('dist', { recursive: true });

const testFiles = readdirSync('test')
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => join('test', f));

const outfiles = [];
for (const entry of testFiles) {
  const base    = entry.replace(/^test[\\/]/, '').replace(/\.js$/, '');
  const outfile = `dist/${base}.mjs`;
  await build({
    entryPoints: [resolve(entry)],
    bundle:   true,
    outfile,
    platform: 'node',
    format:   'esm',
    target:   'node18',
    jsx:      'automatic',
    packages: 'external',
    alias: { 'react-devtools-core': resolve('src/stubs/react-devtools-core.js') },
    logLevel: 'warning',
  });
  outfiles.push(outfile);
}

const result = spawnSync('node', ['--test', ...outfiles], { stdio: 'inherit' });
process.exit(result.status ?? 0);
