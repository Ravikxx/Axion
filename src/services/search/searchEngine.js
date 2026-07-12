// Unified file-search engine.
//
// Mirrors opencodeAX/packages/core/src/filesystem/search.ts: pick the best
// available backend (ripgrep first, in-process fs adapter as fallback) and
// expose a single `find` / `glob` / `grep` API used by the agent's tools.
// `auto` mode auto-selects per-call so disabling ripgrep at runtime is
// always honored.

import { ripgrepAvailable, ripgrepPath, rgGlob, rgGrep } from './ripgrepAdapter.js';
import { fsGlob, fsGrep, fsFind } from './fsAdapter.js';
import { SEARCH_CONFIG, resolveBackend } from './searchConfig.js';

function sharedOpts(opts) {
  return {
    includeHidden: opts.includeHidden ?? SEARCH_CONFIG.includeHidden,
    excludeGit: opts.excludeGit ?? SEARCH_CONFIG.excludeGit,
    limit: opts.limit ?? SEARCH_CONFIG.maxResults,
  };
}

export async function searchGlob({ cwd, pattern, ...opts }) {
  const o = sharedOpts(opts);
  if (resolveBackend() === 'ripgrep' && ripgrepAvailable()) {
    const out = await rgGlob({ cwd, pattern, ...o });
    if (out) return out;
  }
  return fsGlob({ cwd, pattern, ...o });
}

export async function searchGrep({ cwd, pattern, include, ...opts }) {
  const o = sharedOpts(opts);
  if (resolveBackend() === 'ripgrep' && ripgrepAvailable()) {
    const out = await rgGrep({ cwd, pattern, include, ...o });
    if (out) return out;
  }
  return fsGrep({ cwd, pattern, include, ...o });
}

export function searchFind({ cwd, query, type, limit }) {
  return fsFind({ cwd, query, type, limit: limit ?? 50 });
}

export function searchBackendInfo() {
  return {
    backend: resolveBackend(),
    ripgrepAvailable: ripgrepAvailable(),
    ripgrepPath: ripgrepAvailable() ? ripgrepPath() : null,
    maxResults: SEARCH_CONFIG.maxResults,
    includeHidden: SEARCH_CONFIG.includeHidden,
  };
}