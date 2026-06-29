#!/usr/bin/env node
// Production launcher. OpenTUI's renderer requires Bun, but Axion installs/launches
// via Node. This Node entry re-execs the TUI under the bundled Bun binary — and
// falls back to a plain Node readline UI when Bun/OpenTUI isn't usable, so Axion
// runs everywhere Node does (unsupported platforms, odd terminals, piped input).
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const main = join(here, 'main.jsx');
const fallback = join(here, 'fallback.js');
const args = process.argv.slice(2);

// Locate the Bun binary from the `bun` dependency; null if not present for this platform.
function resolveBun() {
  try {
    const pkgDir = dirname(require.resolve('bun/package.json'));
    const bin = join(pkgDir, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
    if (existsSync(bin)) return bin;
  } catch {}
  return null;
}

function runFallback() {
  const child = spawn(process.execPath, [fallback, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => { console.error('Axion failed to start:', err.message); process.exit(1); });
}

const bun = resolveBun();
const interactive = process.stdout.isTTY && process.stdin.isTTY;

// No Bun for this platform, or non-interactive (piped) input → plain UI.
if (!bun || !interactive) {
  runFallback();
} else {
  const child = spawn(bun, [main, ...args], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (code === 87) { runFallback(); return; } // OpenTUI renderer unavailable
    if (signal) { try { process.kill(process.pid, signal); } catch {} }
    process.exit(code ?? 0);
  });
  child.on('error', () => runFallback()); // Bun failed to spawn → fall back
}
