// In-process search adapter — used when ripgrep is unavailable,disabled, or when targeting very small directories.
//
// Ports opencode's `ripgrepLayer` fallback (the `fffLayer` no-op case where
// both binary backends are unavailable) to Axion: keep the project vows of
// skipping node_modules/.git/dist and binary files, but stay fully in JS so
// no external binary is needed. Mirrors the existing walkGlob/grepWalk logic
// in src/agent/tools.js so behaviour matches what users see today when rg
// is missing.

import { readdirSync, readFileSync, statSync } from 'fs';
import { resolve, relative, sep, extname } from 'path';

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', '__pycache__',
  '.cache', 'coverage', '.turbo', 'out', '.svelte-kit', 'vendor',
  '.venv', 'venv', 'target',
]);

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.woff',
  '.woff2', '.ttf', '.eot', '.bin', '.zip', '.gz', '.pdf', '.jar',
  '.class', '.so', '.dylib', '.dll', '.exe', '.node',
]);

export function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
      else { re += '.*'; i += 1; }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function walk(root, pattern, results, dir, includeHidden, excludeGit) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (!includeHidden && e.name.startsWith('.') && e.name !== '.') continue;
    if (excludeGit && e.name === '.git') continue;
    const full = resolve(dir, e.name);
    if (e.isDirectory()) {
      walk(root, pattern, results, full, includeHidden, excludeGit);
    } else {
      const rel = relative(root, full).split(sep).join('/');
      const re = globToRegex(pattern);
      if (re.test(rel) || re.test(e.name)) results.push(rel);
    }
  }
}

export function fsGlob({ cwd, pattern = '*', includeHidden, excludeGit, limit = 500 }) {
  const out = [];
  walk(cwd, pattern, out, cwd, includeHidden, excludeGit);
  return out.slice(0, limit);
}

export function fsGrep({ cwd, pattern, include, includeHidden, excludeGit, limit = 200 }) {
  let re;
  try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(escapeRegex(pattern), 'i'); }
  const includeRe = include ? globToRegex(include) : null;
  const out = [];
  const visit = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (!includeHidden && e.name.startsWith('.') && e.name !== '.') continue;
      if (excludeGit && e.name === '.git') continue;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        visit(full);
        continue;
      }
      if (includeRe && !includeRe.test(e.name)) continue;
      if (BINARY_EXTS.has(extname(e.name).toLowerCase())) continue;
      try {
        const text = readFileSync(full, 'utf8');
        const rel = relative(cwd, full).split(sep).join('/');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            out.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
            if (out.length >= limit) return;
          }
        }
      } catch {}
    }
  };
  visit(cwd);
  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function fsFind({ cwd, query, type = 'file', limit = 50 }) {
  const items = [];
  const collect = (dir) => {
    if (items.length >= limit) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (items.length >= limit) return;
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.')) continue;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        if (type === 'directory' || type === 'mixed') {
          const rel = relative(cwd, full).split(sep).join('/') + '/';
          items.push({ path: rel, type: 'directory' });
        }
        collect(full);
      } else if (type === 'file' || type === 'mixed') {
        const rel = relative(cwd, full).split(sep).join('/');
        items.push({ path: rel, type: 'file' });
      }
    }
  };
  collect(cwd);
  if (!query) return items.slice(0, limit);
  const q = query.toLowerCase();
  const scored = [];
  for (const it of items) {
    const base = it.path.toLowerCase().split('/').pop();
    let score = -1;
    const bi = base.indexOf(q);
    if (bi === 0) score = 1000;
    else if (bi > 0) score = 600 - bi;
    else if (it.path.toLowerCase().includes(q)) score = 300;
    else if (isSubsequence(it.path.toLowerCase(), q)) score = 100;
    if (score >= 0) scored.push({ it, score });
  }
  scored.sort((a, b) => b.score - a.score || a.it.path.length - b.it.path.length);
  return scored.slice(0, limit).map((s) => s.it);
}

function isSubsequence(hay, needle) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}
