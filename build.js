#!/usr/bin/env node
import { chmodSync, rmSync } from 'fs';
import { resolve } from 'path';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints: [resolve('src/index.js')],
  bundle: true,
  outdir: 'dist',
  entryNames: 'axion',
  chunkNames: 'chunks/[name]-[hash]',
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  jsx: 'automatic',
  // platform:node auto-externalises node built-ins; packages:external keeps
  // npm deps external so they resolve from wherever axion is installed.
  packages: 'external',
  alias: {
    // Ink's optional devtools file imports this at the top level — stub it out
    'react-devtools-core': resolve('src/stubs/react-devtools-core.js'),
  },
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});

chmodSync('dist/axion.js', 0o755);

console.log('Build complete → dist/axion.js');
