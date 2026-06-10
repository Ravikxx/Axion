#!/usr/bin/env node
// Dev watch mode: rebuilds dist/axion.js on src changes and auto-reloads
// the Chrome extension when extension/ files change.
//
// Usage: node watch.js
//   Then load the extension in Chrome (chrome://extensions → Load unpacked → extension/).
//   Both CLI and extension will hot-reload on every save.

import { watch } from 'fs';
import { createServer } from 'http';
import { context } from 'esbuild';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR   = join(__dirname, 'extension');
const RELOAD_PORT = 35729;

// ── Reload token server ───────────────────────────────────────────────────────
// background.js polls this for a changing token; when it changes it calls
// chrome.runtime.reload() so the extension picks up new source files.

let reloadToken = Date.now();

const server = createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ token: reloadToken }));
});

server.listen(RELOAD_PORT, '127.0.0.1', () => {
  console.log(`\x1b[36m◈ Extension live-reload server\x1b[0m  →  http://127.0.0.1:${RELOAD_PORT}`);
});

// ── Extension file watcher ────────────────────────────────────────────────────

watch(EXT_DIR, { recursive: true }, (event, filename) => {
  if (!filename || filename.startsWith('.')) return;
  reloadToken = Date.now();
  console.log(`\x1b[35m📦 Extension changed:\x1b[0m  ${filename}  \x1b[2m(token → ${reloadToken})\x1b[0m`);
});

// ── esbuild watch — CLI bundle ────────────────────────────────────────────────

const ctx = await context({
  entryPoints: ['src/index.js'],
  bundle:      true,
  outfile:     'dist/axion.js',
  platform:    'node',
  format:      'esm',
  target:      'node18',
  jsx:         'automatic',
  packages:    'external',
  alias:       { 'react-devtools-core': './src/stubs/react-devtools-core.js' },
  banner:      { js: '#!/usr/bin/env node' },
  logLevel:    'info',
});

await ctx.watch();
console.log('\x1b[36m◈ Watching src/\x1b[0m  →  dist/axion.js  (Ctrl+C to stop)\n');
