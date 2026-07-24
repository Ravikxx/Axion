// Text-oriented interactive diff viewer for the Axion TUI.
//
// Ports opencodeAX/packages/tui/src/feature-plugins/system/diff-viewer.tsx
// (a Solid-based pane UI) into a print-friendly text renderer that runs
// inside the existing Axion chat surface (mirrors how /context is rendered
// via contextViz.js). Supports the three diff sources from the reference:
// working tree, main branch, and last-turn (snapshot-based) diffs, and
// renders a file tree sidebar + split or unified per-file diff. Hunk markers
// (@@) are computed so callers can build jump navigation separately.

import { execSync } from 'child_process';
import { diffLines, diffStats } from '../../utils/diff.js';
import {
  buildFileTree, flattenFileTree, allExpandedFileTreeDirectories,
} from './diffFileTree.js';

const CONTEXT_LINES = 3;
const STATUS_LETTER = { added: 'A', deleted: 'D', modified: 'M', untracked: '?' };
const SOURCE_LABEL = {
  'working-tree': 'working tree',
  'branch': 'main branch',
  'last-turn': 'last turn',
};

function git(cwd, args) {
  try {
    return execSync(['git', ...args].join(' '), {
      cwd,
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return err.stdout || '';
  }
}

function parseGitDiffNames(cwd, diffText) {
  const files = [];
  for (const line of diffText.split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!m) continue;
    const path = m[2];
    files.push({ file: path, patch: '', additions: 0, deletions: 0, status: 'modified' });
  }
  if (!files.length) {
    // Fall back to porcelain status — picks up untracked files too.
    const status = git(cwd, ['status', '--porcelain']);
    for (const line of status.split('\n')) {
      if (!line) continue;
      const code = line[0].trim() || line[1];
      const path = line.slice(3);
      const statusKind =
        code === 'A' ? 'added' :
        code === 'D' ? 'deleted' :
        code === '?' ? 'added' : 'modified';
      files.push({ file: path, patch: '', additions: 0, deletions: 0, status: statusKind });
    }
  }
  return files;
}

// `git diff` only reports tracked files — merge in untracked (new) files
// from porcelain status so they show up alongside tracked changes.
function mergeUntrackedFiles(cwd, files) {
  const seen = new Set(files.map((f) => f.file));
  const status = git(cwd, ['status', '--porcelain']);
  const merged = [...files];
  for (const line of status.split('\n')) {
    if (!line) continue;
    const code = line[0].trim() || line[1];
    if (code !== '?') continue;
    const path = line.slice(3);
    if (seen.has(path)) continue;
    merged.push({ file: path, patch: '', additions: 0, deletions: 0, status: 'added' });
    seen.add(path);
  }
  return merged;
}

function parsePatchHunks(diffText) {
  const patches = [];
  let currentFile = null;
  let hunk = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git')) {
      if (currentFile) patches.push(currentFile);
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentFile = m ? { file: m[2], header: line, additions: 0, deletions: 0, hunks: [] } : null;
      continue;
    }
    if (!currentFile) continue;
    if (line.startsWith('@@')) {
      hunk = { marker: line, lines: [] };
      currentFile.hunks.push(hunk);
      continue;
    }
    if (hunk) {
      if (line.startsWith('+')) { currentFile.additions++; hunk.lines.push(line); }
      else if (line.startsWith('-')) { currentFile.deletions++; hunk.lines.push(line); }
      else hunk.lines.push(line);
    }
  }
  if (currentFile) patches.push(currentFile);
  return patches;
}

function loadDiff(cwd, mode, lastTurnProvider) {
  if (mode === 'last-turn' && lastTurnProvider) {
    const data = lastTurnProvider();
    if (!data || !data.length) return [];
    return data.map((d) => ({
      file: d.path,
      additions: d.added ?? 0,
      deletions: d.removed ?? 0,
      status: d.status || 'modified',
      patch: d.patch || '',
    }));
  }
  if (mode === 'branch') {
    const base = detectMainBranch(cwd);
    const diffText = git(cwd, ['diff', `${base}...HEAD`, `--unified=${CONTEXT_LINES}`]);
    const patches = parsePatchHunks(diffText);
    const files = parseGitDiffNames(cwd, diffText);
    return mergePatchesIntoFiles(files, patches);
  }
  // working-tree (default)
  const diffText = git(cwd, ['diff', `--unified=${CONTEXT_LINES}`]);
  const patches = parsePatchHunks(diffText);
  const files = mergeUntrackedFiles(cwd, parseGitDiffNames(cwd, diffText));
  return mergePatchesIntoFiles(files, patches);
}

function mergePatchesIntoFiles(files, patches) {
  const byPath = new Map(patches.map((p) => [p.file, p]));
  return files.map((f) => {
    const patch = byPath.get(f.file);
    if (!patch) return f;
    return { ...f, patch: patch.header + '\n' + patch.hunks.map((h) => h.marker + '\n' + h.lines.join('\n')).join('\n\n'), additions: patch.additions, deletions: patch.deletions };
  });
}

function detectMainBranch(cwd) {
  for (const candidate of ['main', 'master', 'trunk', 'dev']) {
    const out = git(cwd, ['rev-parse', `--verify`, `${candidate}`]);
    if (out && out.trim()) return candidate;
  }
  return 'main';
}

function renderFileTree(files) {
  if (!files.length) return ['(no changed files)'];
  const tree = buildFileTree(files);
  const expanded = allExpandedFileTreeDirectories(tree);
  const rows = flattenFileTree(tree, expanded);
  const lines = [];
  for (const row of rows) {
    const indent = '  '.repeat(row.depth);
    const marker = row.kind === 'directory' ? '▾ ' : '';
    if (row.kind === 'file' && row.fileIndex !== undefined) {
      const st = files[row.fileIndex]?.status || 'modified';
      const letter = STATUS_LETTER[st] || 'M';
      lines.push(`${indent}${marker}${row.name} [${letter}] +${files[row.fileIndex]?.additions || 0} -${files[row.fileIndex]?.deletions || 0}`);
    } else {
      lines.push(`${indent}${marker}${row.name}/`);
    }
  }
  return lines;
}

function renderUnified(file) {
  const lines = [];
  lines.push(`── ${file.file} ──  +${file.additions} -${file.deletions}`);
  if (file.patch) {
    lines.push(file.patch.split('\n').map((l) => {
      if (l.startsWith('+++')) return `  ${l}`;
      if (l.startsWith('---')) return `  ${l}`;
      if (l.startsWith('+')) return `  ${l}`;
      if (l.startsWith('-')) return `  ${l}`;
      if (l.startsWith('@@')) return `  ${l}`;
      return `  ${l}`;
    }).join('\n'));
  } else {
    lines.push('  (binary file or no textual diff)');
  }
  return lines;
}

function renderSplit(file, width) {
  const lines = [];
  lines.push(`── ${file.file} ──  +${file.additions} -${file.deletions}`);
  if (!file.patch) {
    lines.push('  (binary file or no textual diff)');
    return lines;
  }
  const half = Math.max(20, Math.floor((width - 4) / 2));
  const left = [];
  const right = [];
  for (const line of file.patch.split('\n')) {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('@@')) {
      left.push(truncate(line, half));
      right.push('');
      continue;
    }
    if (line.startsWith('-')) {
      left.push(truncate(line, half));
    } else if (line.startsWith('+')) {
      right.push(truncate(line, half));
    } else {
      left.push(truncate(line, half));
      right.push(truncate(line.slice(1), half));
    }
  }
  const maxRows = Math.max(left.length, right.length);
  for (let i = 0; i < maxRows; i++) {
    lines.push(`${(left[i] || '').padEnd(half)} │ ${right[i] || ''}`);
  }
  return lines;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function findHunks(file) {
  if (!file.patch) return [0];
  const out = [0];
  let idx = 0;
  for (const line of file.patch.split('\n')) {
    if (line.startsWith('@@')) out.push(idx + 1);
    idx++;
  }
  return out;
}

/**
 * Render the diff viewer as a single text block (for the chat surface).
 *
 * @param {object} opts
 * @param {string} opts.cwd Working directory.
 * @param {'working-tree'|'branch'|'last-turn'} [opts.mode] Diff source.
 * @param {number} [opts.width] Terminal width (split fallback if narrow).
 * @param {'split'|'unified'} [opts.view] Force a view (default: auto).
 * @param {() => Array<{path:string,added?:number,removed?:number,status?:string,patch?:string}>} [opts.lastTurnProvider]
 *        Snapshot-backed list of files changed in the most recent turn.
 * @returns {{ text: string, fileCount: number, source: string, files: Array, hunksByFile: Record<string, number[]> }}
 */
export function renderDiffViewer({
  cwd,
  mode = 'working-tree',
  width = 100,
  view = 'auto',
  lastTurnProvider = null,
} = {}) {
  const files = loadDiff(cwd, mode, lastTurnProvider);
  const source = SOURCE_LABEL[mode] || SOURCE_LABEL['working-tree'];
  const autoView = width < 100 || (mode === 'last-turn') ? 'unified' : 'split';
  const effectiveView = view === 'auto' ? autoView : view || autoView;

  const lines = [];
  lines.push(`Diff viewer — source: ${source} · view: ${effectiveView} · files: ${files.length}`, '');

  if (!files.length) {
    lines.push('No changes.');
    return { text: lines.join('\n'), fileCount: 0, source, files, hunksByFile: {} };
  }

  lines.push('Files (tree):');
  for (const l of renderFileTree(files)) lines.push(l);
  lines.push('');

  lines.push('Patches:');
  const hunksByFile = {};
  for (const f of files) {
    const block = effectiveView === 'split' ? renderSplit(f, width) : renderUnified(f);
    lines.push(...block, '');
    hunksByFile[f.file] = findHunks(f);
  }

  return { text: lines.join('\n'), fileCount: files.length, source, files, hunksByFile, view: effectiveView };
}
