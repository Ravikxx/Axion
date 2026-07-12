// Consolidation lock — adapted from openclaude's consolidationLock.ts to
// Axion's sync-fs style. The lock file's mtime IS lastConsolidatedAt (0 if
// absent). Body is the holder's PID. Stale past HOLDER_STALE_MS even if the
// PID is live (PID-reuse guard); a dead PID is reclaimed by overwriting the
// file with our own PID; two reclaimers race-resolve by re-reading.
//
// Live inside the memories dir so it keys on the same git-root-like scope
// and is writable regardless of where the memory path came from.

import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync, unlinkSync, utimesSync } from 'fs';
import { join } from 'path';
import { getMemoriesDir } from '../memories/memoryStore.js';

const LOCK_FILE = '.consolidate-lock';
const HOLDER_STALE_MS = 60 * 60 * 1000;

function lockPath() { return join(getMemoriesDir(), LOCK_FILE); }

function isProcessRunning(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// mtime of the lock file = lastConsolidatedAt. 0 if absent.
export function readLastConsolidatedAt() {
  try { return statSync(lockPath()).mtimeMs; }
  catch { return 0; }
}

// Acquire: write PID → mtime = now. Returns the pre-acquire mtime (for
// rollback) or null if blocked / lost a race.
export function tryAcquireConsolidationLock() {
  const path = lockPath();
  let priorMtime;
  let holderPid;
  try {
    const s = statSync(path);
    priorMtime = s.mtimeMs;
    holderPid = parseInt(readFileSync(path, 'utf8').trim(), 10);
  } catch { /* ENOENT — no prior lock */ }

  if (priorMtime !== undefined && Date.now() - priorMtime < HOLDER_STALE_MS) {
    if (holderPid !== undefined && isProcessRunning(holderPid)) return null;
    // Dead PID or unparseable body — reclaim.
  }

  if (!existsSync(getMemoriesDir())) mkdirSync(getMemoriesDir(), { recursive: true });
  writeFileSync(path, String(process.pid));

  // Two reclaimers both write → last wins the PID. Loser bails on re-read.
  let verify;
  try { verify = readFileSync(path, 'utf8'); }
  catch { return null; }
  if (parseInt(verify.trim(), 10) !== process.pid) return null;

  return priorMtime ?? 0;
}

// Rewind mtime to pre-acquire after a failed consolidation. Clears the PID
// body so our still-running process doesn't look like the holder. priorMtime
// 0 → unlink (restore no-file).
export function rollbackConsolidationLock(priorMtime) {
  const path = lockPath();
  try {
    if (priorMtime === 0) { unlinkSync(path); return; }
    writeFileSync(path, '');
    const t = priorMtime / 1000; // utimes wants seconds
    utimesSync(path, t, t);
  } catch { /* best-effort; next trigger delayed to minHours */ }
}

// Stamp from a manual /dream. Optimistic — no completion hook.
export function recordConsolidation() {
  try {
    if (!existsSync(getMemoriesDir())) mkdirSync(getMemoriesDir(), { recursive: true });
    writeFileSync(lockPath(), String(process.pid));
  } catch { /* best-effort */ }
}