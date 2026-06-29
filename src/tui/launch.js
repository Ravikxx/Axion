#!/usr/bin/env node
// Production launcher for the OpenTUI UI. OpenTUI's renderer requires Bun, but
// Axion installs/launches via Node (npm i -g). So this Node entry re-execs the
// TUI under the Bun binary that ships as a dependency (`bun` npm package).
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const main = join(here, 'main.jsx');

// Resolve the Bun binary from the `bun` dependency (platform-specific name).
function resolveBun() {
  try {
    const pkgDir = dirname(require.resolve('bun/package.json'));
    const bin = join(pkgDir, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
    if (existsSync(bin)) return bin;
  } catch {}
  // Fall back to a bun on PATH.
  return process.platform === 'win32' ? 'bun.exe' : 'bun';
}

const bun = resolveBun();
const child = spawn(bun, [main, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) { try { process.kill(process.pid, signal); } catch {} }
  process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error('Failed to launch the Axion TUI under Bun:', err.message);
  console.error('Try reinstalling, or run with AXION_NO_FULLSCREEN on the classic UI.');
  process.exit(1);
});
