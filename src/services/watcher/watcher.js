/**
 * Native file watcher service — event-driven filesystem monitoring.
 * Uses Node fs.watch (inotify on Linux, FSEvents on macOS).
 * Publishes FileWatcher.* events to the agent bus.
 */
import fs from 'fs';
import path from 'path';
import { shouldIgnore } from './ignore.js';
import { filterProtected } from './protected.js';
import { BUS } from '../../agent/bus.js';

// ── Event Types ──────────────────────────────────────────────────────────────
export const FileWatcherEvent = {
  CREATED: 'FileWatcher:Created',
  CHANGED: 'FileWatcher:Changed',
  DELETED: 'FileWatcher:Deleted',
  ERROR:   'FileWatcher:Error',
};

// ── Config ───────────────────────────────────────────────────────────────────
let _enabled = false;
let _watchDir = null;
let _debounceMs = 200;
let _extraIgnore = [];
let _listeners = [];

/** Active watchers: Map<dir, fs.FSWatcher> */
const _watchers = new Map();

/** Debounce timers: Map<filepath, timeout> */
const _timers = new Map();

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if native file watching is available.
 * @returns {boolean}
 */
export function hasNativeBinding() {
  return typeof fs.watch === 'function';
}

/**
 * Get the OS watcher backend name.
 * @returns {string}
 */
function getBackend() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'fs-events';
  if (process.platform === 'linux') return 'inotify';
  return 'unknown';
}

/**
 * Subscribe to file watcher events.
 * @param {(event: string, payload: { file: string, type: 'add'|'change'|'unlink' }) => void} fn
 * @returns {() => void} unsubscribe function
 */
export function onFileChange(fn) {
  _listeners.push(fn);
  return () => {
    _listeners = _listeners.filter(l => l !== fn);
  };
}

/**
 * Emit a file change event to all listeners and to the agent bus.
 * @param {'add'|'change'|'unlink'} eventType
 * @param {string} filepath
 */
function emit(eventType, filepath) {
  const eventMap = {
    add:    FileWatcherEvent.CREATED,
    change: FileWatcherEvent.CHANGED,
    unlink: FileWatcherEvent.DELETED,
  };
  const payload = { file: filepath, event: eventType, at: Date.now() };
  for (const fn of _listeners) {
    try { fn(eventMap[eventType], payload); } catch {}
  }
  // Also push to agent bus so agents can react to file changes
  try { BUS.send('watcher', 'main', { type: eventMap[eventType], ...payload }); } catch {}
}

/**
 * Start watching a directory recursively.
 * @param {string} dir - absolute path to watch
 * @param {{ extraIgnore?: string[], debounceMs?: number }} [opts]
 * @returns {{ stop: () => void, backend: string }}
 */
export function startWatching(dir, opts) {
  if (_watchers.has(dir)) return { stop: () => stopWatching(dir), backend: getBackend() };

  _watchDir = dir;
  _debounceMs = opts?.debounceMs || 200;
  _extraIgnore = opts?.extraIgnore || [];
  _enabled = true;

  const protecteds = new Set(filterProtected(dir));
  const backend = getBackend();

  try {
    const watcher = fs.watch(
      dir,
      { recursive: true },
      (eventType, filename) => {
        if (!filename || !_enabled) return;

        const absFile = path.join(dir, filename);
        const relFile = filename;

        // Skip protected paths
        if (protecteds.has(absFile)) return;

        // Skip ignored paths
        if (shouldIgnore(relFile, { extra: _extraIgnore })) return;

        // Debounce: batch rapid changes
        const existing = _timers.get(absFile);
        if (existing) clearTimeout(existing);

        _timers.set(absFile, setTimeout(() => {
          _timers.delete(absFile);
          // Determine event type from access time
          try {
            const stat = fs.statSync(absFile, { throwIfNoEntry: false });
            if (!stat) {
              emit('unlink', relFile);
            } else if (eventType === 'rename') {
              emit('add', relFile);
            } else {
              emit('change', relFile);
            }
          } catch {
            emit('unlink', relFile);
          }
        }, _debounceMs));
      },
    );

    watcher.on('error', (err) => {
      emit('error', dir);
      try { watcher.close(); } catch {}
      _watchers.delete(dir);
    });

    _watchers.set(dir, watcher);

    return { stop: () => stopWatching(dir), backend };
  } catch (err) {
    _enabled = false;
    return { stop: () => {}, backend: 'none' };
  }
}

/**
 * Stop watching a directory.
 * @param {string} dir
 */
export function stopWatching(dir) {
  const watcher = _watchers.get(dir);
  if (watcher) {
    try { watcher.close(); } catch {}
    _watchers.delete(dir);
  }
}

/**
 * Stop all active watchers.
 */
export function stopAll() {
  for (const [dir] of _watchers) stopWatching(dir);
  for (const timer of _timers.values()) clearTimeout(timer);
  _timers.clear();
  _listeners = [];
  _enabled = false;
}

/**
 * Get status of active watchers.
 * @returns {{ dir: string, backend: string, active: boolean }[]}
 */
export function status() {
  return [..._watchers.keys()].map(dir => ({
    dir,
    backend: getBackend(),
    active: _enabled,
  }));
}

/**
 * Convenience: watch the current working directory.
 * @param {{ extraIgnore?: string[], debounceMs?: number }} [opts]
 * @returns {{ stop: () => void, backend: string }}
 */
export function watchCwd(opts) {
  return startWatching(process.cwd(), opts);
}
