// patchParser.js — Structured patch parsing with typed hunks and context matching.
//
// Parses structured patch objects into typed hunks (add, update, delete) and
// applies them with context validation. Supports BOM preservation and
// concurrent-modification detection via content fingerprinting.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';

/**
 * BOM (Byte Order Mark) for UTF-8 files.
 */
const BOM = '\uFEFF';

/**
 * Detect if content starts with a UTF-8 BOM.
 * @param {string} content
 * @returns {boolean}
 */
export function hasBom(content) {
  return content.charCodeAt(0) === 0xFEFF;
}

/**
 * Strip BOM from content if present. Returns { bom, content }.
 * @param {string} content
 * @returns {{ bom: boolean, content: string }}
 */
export function stripBom(content) {
  if (hasBom(content)) {
    return { bom: true, content: content.slice(1) };
  }
  return { bom: false, content };
}

/**
 * Prepend BOM to content if the original had one.
 * @param {string} content
 * @param {boolean} hasBomFlag
 * @returns {string}
 */
export function prependBom(content, hasBomFlag) {
  return hasBomFlag ? BOM + content : content;
}

/**
 * @typedef {Object} PatchHunk
 * @property {'add'|'update'|'delete'} type
 * @property {string} filePath — target file path
 * @property {string} [find] — exact string to find (for 'update')
 * @property {string} [replace] — replacement string (for 'update')
 * @property {string} [content] — full file content (for 'add')
 * @property {boolean} [all] — replace all occurrences (for 'update')
 * @property {string[]} [context] — lines before/after for context validation
 */

/**
 * @typedef {Object} PatchResult
 * @property {boolean} success
 * @property {string} output — human-readable result
 * @property {PatchHunk[]} hunks — parsed hunks
 * @property {{ added: number, updated: number, deleted: number }} stats
 */

/**
 * Parse a structured patch from the agent's tool input.
 *
 * The patch input can be:
 * - Single hunk: { path, find, replace, all? }
 * - Multi-hunk: { hunks: [{ path, type, find?, replace?, content? }] }
 * - Legacy format: { path, find, replace } (treated as single update hunk)
 *
 * @param {object} input — raw patch input from the tool
 * @returns {PatchHunk[]}
 */
export function parsePatch(input) {
  if (!input) return [];

  // Multi-hunk format
  if (Array.isArray(input.hunks)) {
    return input.hunks.map(h => normalizeHunk(h)).filter(Boolean);
  }

  // Single hunk format (most common from LLM)
  if (input.path && (input.find != null || input.content != null)) {
    const type = input.content != null && input.find == null ? 'add'
      : input.find != null && input.content == null && input.replace == null ? 'delete'
      : 'update';
    return [normalizeHunk({ ...input, type })].filter(Boolean);
  }

  return [];
}

/**
 * Normalize a raw hunk into a typed PatchHunk.
 */
function normalizeHunk(raw) {
  if (!raw || !raw.path) return null;

  const filePath = raw.path;
  const type = raw.type || (raw.content != null && raw.find == null ? 'add'
    : raw.find != null && (raw.replace == null || raw.replace === '') && raw.delete ? 'delete'
    : 'update');

  const hunk = { type, filePath };

  if (type === 'add') {
    hunk.content = raw.content || '';
  } else if (type === 'update') {
    hunk.find = raw.find;
    hunk.replace = raw.replace ?? '';
    hunk.all = !!raw.all;
  } else if (type === 'delete') {
    hunk.find = raw.find; // optional: if provided, validates content before delete
  }

  return hunk;
}

/**
 * Validate context lines before applying an update hunk.
 * Checks that the find string exists in the file content.
 *
 * @param {string} content — current file content (without BOM)
 * @param {PatchHunk} hunk
 * @returns {{ valid: boolean, error?: string, count?: number }}
 */
export function validateHunk(content, hunk) {
  if (hunk.type === 'add') {
    return { valid: true, count: 0 };
  }

  if (hunk.type === 'delete') {
    if (!hunk.find) return { valid: true, count: 1 };
    const count = content.split(hunk.find).length - 1;
    if (count === 0) return { valid: false, error: `Delete string not found in file` };
    return { valid: true, count };
  }

  // update
  const count = content.split(hunk.find).length - 1;
  if (count === 0) {
    return { valid: false, error: `String not found in file` };
  }
  return { valid: true, count };
}

/**
 * Apply a single hunk to file content.
 *
 * @param {string} content — current file content (may include BOM)
 * @param {PatchHunk} hunk
 * @returns {{ content: string, applied: boolean, error?: string, count?: number }}
 */
export function applyHunk(content, hunk) {
  // Strip BOM, apply patch, re-prepend BOM
  const { bom, content: bareContent } = stripBom(content);

  if (hunk.type === 'add') {
    // 'add' creates a new file — content comes from the hunk
    return { content: prependBom(hunk.content, bom), applied: true, count: 0 };
  }

  if (hunk.type === 'delete') {
    if (!hunk.find) {
      // Delete entire file content (keep empty)
      return { content: prependBom('', bom), applied: true, count: 1 };
    }
    const validation = validateHunk(bareContent, hunk);
    if (!validation.valid) return { content, applied: false, error: validation.error };
    const newContent = bareContent.split(hunk.find).join('');
    return { content: prependBom(newContent, bom), applied: true, count: validation.count };
  }

  // update
  const validation = validateHunk(bareContent, hunk);
  if (!validation.valid) return { content, applied: false, error: validation.error };

  // Use a function replacer to prevent JS from interpreting $& $1 $` $' etc.
  const newContent = hunk.all
    ? bareContent.split(hunk.find).join(hunk.replace)
    : bareContent.replace(hunk.find, () => hunk.replace);

  return { content: prependBom(newContent, bom), applied: true, count: validation.count };
}

/**
 * Compute a content fingerprint for concurrent-modification detection.
 * Simple hash of the content string.
 *
 * @param {string} content
 * @returns {string} hex fingerprint
 */
export function contentFingerprint(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return hash.toString(16);
}

/**
 * Write-if-unchanged: writes content only if the file's current content
 * matches the expected fingerprint. Detects concurrent modifications.
 *
 * @param {string} absPath
 * @param {string} newContent
 * @param {string} expectedFingerprint
 * @returns {{ success: boolean, error?: string }}
 */
export function writeIfUnchanged(absPath, newContent, expectedFingerprint) {
  try {
    const current = readFileSync(absPath, 'utf8');
    const currentFp = contentFingerprint(current);
    if (currentFp !== expectedFingerprint) {
      return { success: false, error: 'File was modified externally since last read. Re-read and try again.' };
    }
    writeFileSync(absPath, newContent, 'utf8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
