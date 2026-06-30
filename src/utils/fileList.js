import { readdirSync } from 'fs';
import { join, relative, sep } from 'path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage',
  '.turbo', 'out', '.svelte-kit', 'vendor', '__pycache__', '.venv', 'venv',
]);

// Walk the project for files (skipping vendor/build dirs and dotfolders),
// returning forward-slash relative paths. Breadth-first so shallow files surface
// first, with a per-directory cap so one giant folder can't starve the rest.
export function listProjectFiles(root = process.cwd(), max = 6000, perDir = 1000) {
  const out = [];
  const queue = [root];
  while (queue.length && out.length < max) {
    const dir = queue.shift();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    let added = 0;
    for (const e of entries) {
      if (out.length >= max) break;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        queue.push(join(dir, e.name));
      } else if (added < perDir) {
        out.push(relative(root, join(dir, e.name)).split(sep).join('/'));
        added++;
      }
    }
  }
  return out;
}

function isSubsequence(hay, needle) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}

// Rank files against a query: exact basename hit > path substring > subsequence.
// Empty query returns the first `limit` files (shallowest first).
export function fuzzyFilter(files, query, limit = 8) {
  if (!query) {
    return [...files].sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length).slice(0, limit);
  }
  const q = query.toLowerCase();
  const scored = [];
  for (const f of files) {
    const lf = f.toLowerCase();
    const base = lf.split('/').pop();
    let score = -1;
    const bi = base.indexOf(q);
    if (bi === 0) score = 1000;
    else if (bi > 0) score = 600 - bi;
    else if (lf.includes(q)) score = 300 - lf.indexOf(q);
    else if (isSubsequence(lf, q)) score = 100;
    if (score >= 0) scored.push({ f, score });
  }
  scored.sort((a, b) => b.score - a.score || a.f.length - b.f.length);
  return scored.slice(0, limit).map((s) => s.f);
}
