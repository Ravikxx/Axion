import { basename, extname } from 'path';

const FOLDERS = new Set([
  'node_modules',
  'bower_components',
  '.pnpm-store',
  'vendor',
  '.npm',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  'bin',
  'obj',
  '.git',
  '.svn',
  '.hg',
  '.vscode',
  '.idea',
  '.turbo',
  '.output',
  'desktop',
  '.sst',
  '.cache',
  '.webkit-cache',
  '__pycache__',
  '.pytest_cache',
  'mypy_cache',
  '.history',
  '.gradle',
  '.opencodeAX',
  '.openclaudeAX',
]);

const SKIP_EXTS = new Set([
  '.pyc',
  '.pyo',
  '.class',
  '.o',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.DS_Store',
  '.swp',
  '.swo',
  '.log',
]);

const SKIP_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.gitkeep',
]);

export const PATTERNS = [...FOLDERS];

/**
 * Check if a file path should be ignored by the watcher.
 * @param {string} filepath - relative file path (forward slashes)
 * @param {{ extra?: string[] }} [opts]
 * @returns {boolean}
 */
export function shouldIgnore(filepath, opts) {
  const parts = filepath.split('/');
  // Check folder names
  for (const part of parts) {
    if (FOLDERS.has(part)) return true;
  }
  // Check file-level patterns
  const name = basename(filepath);
  if (SKIP_FILES.has(name)) return true;
  if (SKIP_EXTS.has(extname(filepath))) return true;
  // Extra patterns (glob-like: simple prefix/suffix match)
  if (opts?.extra) {
    for (const pattern of opts.extra) {
      if (filepath.includes(pattern)) return true;
    }
  }
  return false;
}

/**
 * Build the full ignore list (base patterns + extras) for @parcel/watcher or fs.watch.
 * @param {{ extra?: string[] }} [opts]
 * @returns {string[]}
 */
export function buildIgnoreList(opts) {
  return [...PATTERNS, ...(opts?.extra || [])];
}
