import React from 'react';
import { accent } from '../ui/theme.js';
import { collapseDiff, diffStats } from '../utils/diff.js';
import { highlightLine, langFromPath } from '../ui/markdown.js';

// OpenTUI tool-call renderer: header (status + name + label + diff stats),
// a colored unified diff for file writes, or truncated plain output otherwise.

const C = { ok: '#7ee787', fail: '#f85149', pending: '#f0c674', gray: '#888', add: '#7ee787', rem: '#f85149' };
const CODE_COLORS = { comment: '#6e7681', string: '#7ee787', keyword: '#d2a8ff', number: '#f0c674', fn: '#79c0ff', plain: undefined };
const FILE_READ_TOOLS = new Set(['read_file', 'read_file_lines']);

// Which highlighter language (if any) to use for a tool's output.
function outputLang(name, input) {
  if (FILE_READ_TOOLS.has(name)) return langFromPath(input?.path);
  if (name === 'run_command') return 'sh'; // shell output — colors strings, numbers, paths
  return null;
}

// One output line — syntax-highlighted when it's file content, else plain.
function OutputLine({ line, lang, fail }) {
  if (fail || !lang) return <text><span fg={fail ? C.fail : C.gray}>{line}</span></text>;
  const m = line.match(/^(\s*\d+)\t(.*)$/); // read_file_lines "N\tcode" prefix
  const prefix = m ? m[1] : '';
  const code = m ? m[2] : line;
  const toks = highlightLine(code, lang);
  return (
    <text>
      {prefix ? <span fg="#555">{`${prefix} `}</span> : null}
      {toks.map((t, i) => { const c = CODE_COLORS[t.type]; return c ? <span key={i} fg={c}>{t.text}</span> : <span key={i}>{t.text}</span>; })}
    </text>
  );
}

const COLLAPSE_LIMIT = 6; // tool blocks taller than this collapse to one line

export function ToolBlock({ name, input, output, success, pending, diff, expanded = false, onToggle }) {
  if (name && name.includes('sequentialthinking')) {
    return <ThinkingStep input={input} pending={pending} />;
  }

  const A = accent();
  const label = formatLabel(name, input);
  const statusColor = pending ? C.pending : success === false ? C.fail : C.ok;
  const dot = pending ? '◌' : success === false ? '✖' : '✔';
  const hasDiff = diff && diff.length > 0;
  const stats = hasDiff ? diffStats(diff) : null;
  const showDiff = hasDiff && !pending;

  // How many lines would the body take? Collapse big blocks to a one-liner.
  const bodyLines = pending ? 0
    : hasDiff ? diff.length
    : output ? String(output).split('\n').length : 0;
  const collapsible = !pending && bodyLines > COLLAPSE_LIMIT;
  const collapsed = collapsible && !expanded;
  const chevron = collapsible ? (expanded ? '▾ ' : '▸ ') : '';

  const header = (
    <text>
      {collapsible ? <span fg={C.gray}>{chevron}</span> : null}
      <span fg={statusColor}>{dot} </span>
      <span fg={A}>{name}</span>
      {label ? <span fg={C.gray}>{`  ${label}`}</span> : null}
      {pending ? <span fg={C.pending}>  running…</span> : null}
      {showDiff && stats ? (
        <span>
          {stats.added > 0 ? <span fg={C.add}>{`  +${stats.added}`}</span> : null}
          {stats.removed > 0 ? <span fg={C.rem}>{`  -${stats.removed}`}</span> : null}
        </span>
      ) : null}
      {collapsed ? <span fg={C.gray}>{`   +${bodyLines} lines · click to expand`}</span> : null}
    </text>
  );

  return (
    <box style={{ flexDirection: 'column', marginLeft: 2, marginTop: 0 }}>
      {collapsible
        ? <box onMouseDown={() => onToggle?.()}>{header}</box>
        : header}

      {!collapsed && showDiff ? <DiffView diff={diff} expanded /> : null}

      {!collapsed && !pending && output && !showDiff ? (
        <box style={{ flexDirection: 'column', marginLeft: 2 }}>
          {formatOutput(output, name, true).split('\n').map((l, i) => (
            <OutputLine key={i} line={l} fail={success === false} lang={outputLang(name, input)} />
          ))}
        </box>
      ) : null}
    </box>
  );
}

function DiffView({ diff, expanded }) {
  let lines = expanded ? diff : collapseDiff(diff, 2);
  let truncated = 0;
  if (lines.length > MAX_EXPAND) { truncated = lines.length - MAX_EXPAND; lines = lines.slice(0, MAX_EXPAND); }
  const W = 4;
  return (
    <box style={{ flexDirection: 'column', marginLeft: 2 }}>
      {lines.map((entry, i) => {
        if (entry.type === 'gap') {
          return <text key={i}><span fg={C.gray}>{`${'·'.repeat(W)}  … ${entry.count} unchanged line${entry.count !== 1 ? 's' : ''}`}</span></text>;
        }
        const { type, line, lineNo } = entry;
        const lineNoStr = String(lineNo).padStart(W, ' ');
        const prefix = type === 'add' ? '+' : type === 'remove' ? '-' : ' ';
        const color = type === 'add' ? C.add : type === 'remove' ? C.rem : C.gray;
        return (
          <text key={i}>
            <span fg={C.gray}>{`${lineNoStr} `}</span>
            <span fg={color}>{`${prefix} ${line}`}</span>
          </text>
        );
      })}
      {truncated > 0 ? <text><span fg={C.gray}>{`… ${truncated} more diff lines (too long to show in full)`}</span></text> : null}
    </box>
  );
}

function ThinkingStep({ input, pending }) {
  if (!input) return null;
  const { thought, thoughtNumber, totalThoughts, isRevision, revisesThought, branchId } = input;
  const num = thoughtNumber || '?';
  const total = totalThoughts || '?';
  const badge = isRevision ? ` (revising #${revisesThought})` : branchId ? ` [branch ${branchId}]` : '';
  return (
    <box style={{ flexDirection: 'column', marginLeft: 2 }}>
      <text>
        <span fg="#d2a8ff">{pending ? '◌ ' : '💭 '}</span>
        <span fg="#d2a8ff">{`Thought ${num}/${total}`}</span>
        {badge ? <span fg={C.gray}>{badge}</span> : null}
        {pending ? <span fg={C.pending}>  thinking…</span> : null}
      </text>
      {thought ? <text><span fg={C.gray}>{`  ${truncate(thought, 200)}`}</span></text> : null}
    </box>
  );
}

function formatLabel(name, input) {
  if (!input) return '';
  switch (name) {
    case 'read_file':      return input.path || '';
    case 'read_file_lines': return input.path ? `${input.path}:${input.start}-${input.end ?? ''}` : '';
    case 'write_file':     return input.path || '';
    case 'patch_file':     return input.path || '';
    case 'delete_file':    return input.path || '';
    case 'move_file':      return input.from ? `${input.from} → ${input.to}` : '';
    case 'list_directory': return input.path || '.';
    case 'run_command':    return truncate(input.command, 72);
    case 'send_input':     return input.id ? `→ ${input.id}` : '';
    case 'check_task':     return input.id || '';
    case 'git_commit':     return `"${truncate(input.message, 50)}"`;
    case 'web_search':     return `"${truncate(input.query, 60)}"`;
    case 'fetch_url':      return truncate(input.url, 60);
    case 'screenshot':     return input.question ? `"${truncate(input.question, 50)}"` : '';
    default:               return '';
  }
}

// Even when expanded, cap the rendered lines — rendering thousands of <text>
// nodes at once can segfault OpenTUI's native renderer under Bun.
const MAX_EXPAND = 300;

function formatOutput(output, name, expanded) {
  const lines = String(output).split('\n');
  const MAX = expanded ? MAX_EXPAND : (name === 'run_command' ? 20 : 12);
  if (lines.length <= MAX) return String(output);
  const more = lines.length - MAX;
  const note = expanded
    ? `\n… ${more} more lines (too long to show in full — read the file/range directly)`
    : `\n… ${more} more lines  (Ctrl+R to expand)`;
  return lines.slice(0, MAX).join('\n') + note;
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n) + '…' : str;
}
