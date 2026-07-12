import { writeFileSync, renameSync, mkdirSync, existsSync, readFileSync, unlinkSync, appendFileSync } from 'fs';
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
  ensureDir(target);
  const tmp = tmpPath(target);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, space), 'utf8');
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

export function writeTextAtomic(target, text) {
  ensureDir(target);
  const tmp = tmpPath(target);
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, target);
  } catch (e) {
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
