// Ripgrep-powered search adapter.
//
// Ports opencodeAX/packages/core/src/ripgrep.ts: spawn `rg` with `--json`
// output for grep, and `--files` for glob/find. Returns structured results
// (file path + line number + matched line text) that the caller can format.
// If `rg` is unavailable on PATH, every function returns null and the caller
// is expected to fall back to the in-process adapter.

import { execSync, spawn } from 'child_process';

const MAX_RECORD_BYTES = 64 * 1024;

let _rgPath = undefined;

function resolveRgPath() {
  const cmd = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const resolver = process.platform === 'win32' ? 'where' : 'which';
  try {
    const buf = execSync(`${resolver} ${JSON.stringify(cmd)}`, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'], // silence missing-rg errors
    });
    const first = buf.split('\n').map((l) => l.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

_rgPath = resolveRgPath();

export function ripgrepPath() {
  return _rgPath;
}

export function ripgrepAvailable() {
  return Boolean(_rgPath);
}

function buildFilesArgs({ pattern, includeHidden, excludeGit }) {
  const args = ['--no-config', '--no-messages'];
  if (includeHidden) args.push('--hidden');
  if (excludeGit !== false) args.push('--glob=!**/.git/**');
  args.push('--files');
  if (pattern && pattern !== '*') args.push(`--glob=${pattern}`);
  return args;
}

function buildGrepArgs({ pattern, include, includeHidden, excludeGit }) {
  const args = ['--no-config', '--no-messages', '--json'];
  if (includeHidden) args.push('--hidden');
  if (excludeGit !== false) args.push('--glob=!**/.git/**');
  if (include) args.push(`--glob=${include}`);
  args.push('--', pattern);
  return args;
}

function runRg(args, cwd) {
  return new Promise((resolve) => {
    if (!_rgPath) { resolve({ ok: false, stdout: '', stderr: 'no rg', code: -1 }); return; }
    const chunks = [];
    let stderr = '';
    const proc = spawn(_rgPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (chunk) => {
      const next = Buffer.concat([...chunks, chunk]);
      if (next.length > MAX_RECORD_BYTES) {
        // Truncate the buffer to cap runaway output.
        chunks.push(chunk.subarray(0, Math.max(0, MAX_RECORD_BYTES - next.length + chunk.length)));
        try { proc.kill('SIGTERM'); } catch {}
        return;
      }
      chunks.push(chunk);
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    proc.on('error', () => resolve({ ok: false, stdout: '', stderr, code: -1 }));
    proc.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf8');
      resolve({ ok: code === 0 || code === 1, stdout, stderr, code });
    });
  });
}

export async function rgGlob({ cwd, pattern, includeHidden, excludeGit, limit = 500 }) {
  if (!_rgPath) return null;
  const args = buildFilesArgs({ pattern, includeHidden, excludeGit });
  args.push('.');
  const { ok, stdout, code } = await runRg(args, cwd);
  if (!ok && code !== 1) return null;
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(0, limit);
}

export async function rgGrep({ cwd, pattern, include, includeHidden, excludeGit, limit = 200 }) {
  if (!_rgPath) return null;
  const args = buildGrepArgs({ pattern, include, includeHidden, excludeGit });
  args.push('.');
  const { ok, stdout, code } = await runRg(args, cwd);
  if (!ok && code !== 1) return null;
  const records = [];
  for (const line of stdout.split('\n')) {
    if (!line || line.length > MAX_RECORD_BYTES) continue;
    let json;
    try { json = JSON.parse(line); } catch { continue; }
    if (json.type !== 'match') continue;
    const text = (json.data?.lines?.text || '').slice(0, 2000);
    records.push({
      path: (json.data?.path?.text || '').replace(/^\.[\\/]/, ''),
      line: json.data?.line_number,
      text,
    });
    if (records.length >= limit) break;
  }
  return records;
}