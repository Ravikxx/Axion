import {
  writeFileSync, renameSync, mkdirSync, existsSync, readFileSync, unlinkSync,
  appendFileSync, openSync, closeSync, fsyncSync, statSync, chmodSync,
} from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { homedir } from 'os';

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function tmpPath(target) {
  return `${target}.${process.pid}.${randomUUID()}.tmp`;
}

export function writeJsonAtomic(target, data, space = 2) {
  writeAtomic(target, JSON.stringify(data, null, space));
}

export function writeTextAtomic(target, text) {
  writeAtomic(target, text);
}

function writeAtomic(target, text) {
  ensureDir(target);
  const tmp = tmpPath(target);
  let fd = null;
  let existingMode = null;
  try { existingMode = statSync(target).mode; } catch {}
  try {
    fd = openSync(tmp, 'wx', existingMode ?? 0o666);
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, target);
    if (existingMode != null) {
      try { chmodSync(target, existingMode); } catch {}
    }
  } catch (e) {
    if (fd != null) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

export function readText(path) {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch { return null; }
}

export function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return null; }
}

export function writeText(path, text) {
  ensureDir(path);
  writeFileSync(path, text, 'utf8');
}

export function appendText(path, text) {
  ensureDir(path);
  appendFileSync(path, text, 'utf8');
}
