import React from 'react';
import { accent } from '../ui/theme.js';
import { collapseDiff, diffStats } from '../utils/diff.js';

// OpenTUI tool-call renderer: header (status + name + label + diff stats),
// a colored unified diff for file writes, or truncated plain output otherwise.

const C = { ok: '#7ee787', fail: '#f85149', pending: '#f0c674', gray: '#888', add: '#7ee787', rem: '#f85149' };

export function ToolBlock({ name, input, output, success, pending, diff, expanded = false }) {
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

  return (
    <box style={{ flexDirection: 'column', marginLeft: 2, marginTop: 0 }}>
      <text>
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
      </text>

      {showDiff ? <DiffView diff={diff} expanded={expanded} /> : null}

      {!pending && output && !showDiff ? (
        <box style={{ flexDirection: 'column', marginLeft: 2 }}>
          {formatOutput(output, name).split('\n').map((l, i) => (
            <text key={i}><span fg={success === false ? C.fail : C.gray}>{l}</span></text>
          ))}
        </box>
      ) : null}
    </box>
  );
}

function DiffView({ diff, expanded }) {
  const lines = expanded ? diff : collapseDiff(diff, 2);
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

function formatOutput(output, name) {
  const lines = String(output).split('\n');
  const MAX = name === 'run_command' ? 20 : 12;
  if (lines.length <= MAX) return String(output);
  return lines.slice(0, MAX).join('\n') + `\n… ${lines.length - MAX} more lines`;
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n) + '…' : str;
}
