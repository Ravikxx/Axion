import { lstatSync, readlinkSync, realpathSync } from 'fs';
import { resolve, isAbsolute, sep, join, dirname, relative } from 'path';

export class PathEscapeError extends Error {
  constructor(requestedPath, root) {
    super(`Path escapes the workspace root: "${requestedPath}" is outside "${root}"`);
    this.name = 'PathEscapeError';
    this.requestedPath = requestedPath;
    this.root = root;
  }
}

// Windows and (default-configured) macOS filesystems are case-insensitive;
// Linux is case-sensitive. Comparing case-insensitively on win32 only errs
// toward being MORE restrictive if we're wrong about a given volume, never
// less — it can only cause a false rejection, never admit an escape.
const CASE_INSENSITIVE = process.platform === 'win32';
const norm = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p);

function isWithin(root, candidate) {
  const r = norm(root);
  const c = norm(candidate);
  return c === r || c.startsWith(r + sep);
}

const MAX_SYMLINK_DEPTH = 40; // guards against symlink cycles, mirrors typical OS ELOOP limits

// macOS exposes /var as a symlink to /private/var. A user or OS API can hand
// us the alias while the workspace grant stores the canonical path. Resolve
// the deepest existing ancestor so both names are compared in one namespace,
// including files/directories that are about to be created.
function resolveExistingAncestor(target) {
  const missing = [];
  let current = target;
  for (;;) {
    try {
      const canonical = realpathSync(current);
      return missing.reduceRight((path, segment) => join(path, segment), canonical);
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new PathEscapeError(target, target);
      missing.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

// Resolves `requestedPath` (relative or absolute) against `root` and returns
// the fully-resolved absolute path, throwing PathEscapeError if it would
// land outside the canonicalized root.
//
// This walks the path one segment at a time rather than resolving everything
// and comparing once at the end, because a single end-to-end check misses a
// dangling symlink inside root whose target doesn't exist yet: fs.existsSync
// and fs.realpathSync both fail closed (throw/false) on a dangling link, so
// a naive "resolve fully, then compare" implementation would treat the link
// itself as a nonexistent path component and silently keep its literal name
// instead of following where it actually points — exactly the case a tool
// like write_file would still walk through when it creates the target.
// Segment-by-segment resolution catches the escape the moment the symlink
// (dangling or not) is encountered, wherever in the path it occurs.
export function resolveContained(root, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    throw new PathEscapeError(String(requestedPath), root);
  }

  const canonicalRoot = realpathSync(root);
  // path.resolve treats an absolute second argument as replacing the first
  // entirely (resolve('/root', '/etc/passwd') === '/etc/passwd'), so this
  // single call already captures both the relative-traversal case and the
  // absolute-path-elsewhere case — no special-casing needed, the containment
  // check below rejects both uniformly.
  let target = resolve(root, requestedPath);
  try {
    target = resolveExistingAncestor(target);
  } catch {
    throw new PathEscapeError(requestedPath, root);
  }
  if (!isWithin(canonicalRoot, target)) throw new PathEscapeError(requestedPath, root);

  const relFromRoot = relative(canonicalRoot, target);
  const segments = relFromRoot.length ? relFromRoot.split(sep).filter(Boolean) : [];

  let current = canonicalRoot;
  for (const segment of segments) {
    if (segment === '..') {
      // resolve()/relative() should already have normalized '..' out of the
      // path before we get here — treat a literal one surviving as a bug to
      // reject rather than an escape route to trust.
      throw new PathEscapeError(requestedPath, root);
    }
    let next = join(current, segment);
    let depth = 0;
    for (;;) {
      let stat;
      try {
        stat = lstatSync(next);
      } catch {
        break; // doesn't exist yet (e.g. a file about to be created) — nothing more to resolve
      }
      if (!stat.isSymbolicLink()) break;
      if (++depth > MAX_SYMLINK_DEPTH) throw new PathEscapeError(requestedPath, root);
      const link = readlinkSync(next);
      next = isAbsolute(link) ? link : resolve(dirname(next), link);
      if (!isWithin(canonicalRoot, next)) throw new PathEscapeError(requestedPath, root);
    }
    current = next;
  }

  return current;
}
