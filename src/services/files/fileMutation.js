// fileMutation.js — Safe atomic file operations with conditional writes.
//
// Provides low-level file mutation primitives with:
// - BOM (Byte Order Mark) preservation
// - Conditional writes (writeIfUnchanged) for concurrent-modification detection
// - Typed operations: create, write, remove
// - Content fingerprinting for change detection

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { contentFingerprint, hasBom, stripBom, prependBom } from '../patches/patchParser.js';
import { writeTextAtomic } from '../../tui/persistence.js';

/**
 * Create a new file. Fails if the file already exists.
 *
 * @param {string} absPath
 * @param {string} content
 * @returns {{ success: boolean, error?: string }}
 */
export function createFile(absPath, content) {
  if (existsSync(absPath)) {
    return { success: false, error: `File already exists: ${absPath}` };
  }
  try {
    const dir = dirname(absPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(absPath, content, { encoding: 'utf8', flag: 'wx' });
    return { success: true };
  } catch (e) {
    if (e.code === 'EEXIST') return { success: false, error: `File already exists: ${absPath}` };
    return { success: false, error: e.message };
  }
}

/**
 * Write content to a file, creating it if needed.
 * Preserves BOM from existing file if present.
 *
 * @param {string} absPath
 * @param {string} content — new content (without BOM)
 * @param {object} [opts]
 * @param {boolean} [opts.preserveBom=true] — keep existing BOM
 * @returns {{ success: boolean, bom?: boolean, error?: string }}
 */
export function writeFile(absPath, content, { preserveBom = true } = {}) {
  try {
    const dir = dirname(absPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let finalContent = content;
    if (preserveBom && existsSync(absPath)) {
      const existing = readFileSync(absPath, 'utf8');
      if (hasBom(existing)) {
        finalContent = prependBom(content, true);
      }
    }

    writeTextAtomic(absPath, finalContent);
    return { success: true, bom: hasBom(finalContent) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Write content only if the file's current content matches the expected
 * fingerprint. Detects concurrent modifications.
 *
 * @param {string} absPath
 * @param {string} newContent — content to write (without BOM)
 * @param {string} expectedFingerprint — fingerprint from before the edit
 * @param {object} [opts]
 * @param {boolean} [opts.preserveBom=true]
 * @returns {{ success: boolean, error?: string }}
 */
export function writeIfUnchanged(absPath, newContent, expectedFingerprint, { preserveBom = true } = {}) {
  try {
    if (!existsSync(absPath)) {
      return { success: false, error: `File no longer exists: ${absPath}` };
    }
    const current = readFileSync(absPath, 'utf8');
    const currentFp = contentFingerprint(current);
    if (currentFp !== expectedFingerprint) {
      return { success: false, error: 'File was modified externally since last read. Re-read and try again.' };
    }
    // Preserve BOM
    const { bom } = stripBom(current);
    const finalContent = preserveBom ? prependBom(newContent, bom) : newContent;
    writeTextAtomic(absPath, finalContent);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Remove a file. Fails if the file does not exist.
 *
 * @param {string} absPath
 * @returns {{ success: boolean, error?: string }}
 */
export function removeFile(absPath) {
  if (!existsSync(absPath)) {
    return { success: false, error: `File not found: ${absPath}` };
  }
  try {
    unlinkSync(absPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Get a content fingerprint for the given file.
 * Returns null if the file doesn't exist.
 *
 * @param {string} absPath
 * @returns {string|null}
 */
export function fingerprintFile(absPath) {
  try {
    const content = readFileSync(absPath, 'utf8');
    return contentFingerprint(content);
  } catch {
    return null;
  }
}

/**
 * Read a file and return its content with BOM info.
 *
 * @param {string} absPath
 * @returns {{ content: string, bom: boolean, fingerprint: string } | null}
 */
export function readFileWithMeta(absPath) {
  try {
    const raw = readFileSync(absPath, 'utf8');
    const { bom, content } = stripBom(raw);
    return { content, bom, fingerprint: contentFingerprint(raw) };
  } catch {
    return null;
  }
}
