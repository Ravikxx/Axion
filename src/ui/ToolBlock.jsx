import React from 'react';
import { Box, Text } from 'ink';
import { collapseDiff, diffStats } from '../utils/diff.js';

export function ToolBlock({ name, input, output, success, pending, diff, expanded }) {
  // Special rendering for sequential thinking steps
  if (name && name.includes('sequentialthinking')) {
    return <ThinkingStep input={input} pending={pending} />;
  }

  const label       = formatLabel(name, input);
  const statusColor = pending ? 'yellow' : success === false ? 'red' : 'greenBright';
  const dot         = pending ? '◌' : success === false ? '✖' : '✔';

  const hasDiff  = diff && diff.length > 0;
  const stats    = hasDiff ? diffStats(diff) : null;
  const showDiff = hasDiff && !pending;

  return (
    <Box flexDirection="column" marginLeft={2} marginY={0}>
      {/* Header */}
      <Box gap={1}>
        <Text color={statusColor}>{dot}</Text>
        <Text color="cyan" bold>{name}</Text>
        {label ? <Text color="gray">{label}</Text> : null}
        {pending && <Text color="yellow"> running…</Text>}
        {showDiff && stats && (
          <Text color="gray">
            {stats.added > 0 ? <Text color="greenBright">+{stats.added}</Text> : null}
            {stats.added > 0 && stats.removed > 0 ? <Text color="gray"> </Text> : null}
            {stats.removed > 0 ? <Text color="red">-{stats.removed}</Text> : null}
          </Text>
        )}
      </Box>

      {/* Diff view for write_file */}
      {showDiff && (
        <DiffView diff={diff} expanded={expanded} />
      )}

      {/* Plain output for non-diff tools */}
      {!pending && output && !showDiff && (
        <Box marginLeft={2} flexDirection="column">
          <Text color={success === false ? 'red' : 'gray'}>
            {formatOutput(output, name)}
          </Text>
        </Box>
      )}

      {/* Expand hint when there's a diff */}
      {showDiff && !expanded && (
        <Box marginLeft={2}>
          <Text color="gray">Ctrl+O to expand</Text>
        </Box>
      )}
    </Box>
  );
}

function ThinkingStep({ input, pending }) {
  if (!input) return null;
  const { thought, thoughtNumber, totalThoughts, isRevision, revisesThought, branchId } = input;
  const num   = thoughtNumber || '?';
  const total = totalThoughts || '?';
  const dot   = pending ? '◌' : '💭';
  const badge = isRevision
    ? ` (revising #${revisesThought})`
    : branchId ? ` [branch ${branchId}]` : '';

  return (
    <Box flexDirection="column" marginLeft={2} marginY={0}>
      <Box gap={1}>
        <Text color="magenta">{dot}</Text>
        <Text color="magenta" bold>Thought {num}/{total}</Text>
        {badge ? <Text color="gray">{badge}</Text> : null}
        {pending && <Text color="yellow"> thinking…</Text>}
      </Box>
      {thought && (
        <Box marginLeft={2}>
          <Text color="gray">{truncate(thought, 200)}</Text>
        </Box>
      )}
    </Box>
  );
}

function DiffView({ diff, expanded }) {
  const lines    = expanded ? diff : collapseDiff(diff, 2);
  const lineNoW  = 4; // width for line number column

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={0}>
      {lines.map((entry, i) => {
        if (entry.type === 'gap') {
          return (
            <Box key={i}>
              <Text color="gray">{'·'.repeat(lineNoW)}  … {entry.count} unchanged line{entry.count !== 1 ? 's' : ''}</Text>
            </Box>
          );
        }

        const { type, line, lineNo } = entry;
        const lineNoStr = String(lineNo).padStart(lineNoW, ' ');
        const prefix    = type === 'add' ? '+' : type === 'remove' ? '-' : ' ';
        const color     = type === 'add' ? 'green' : type === 'remove' ? 'red' : 'gray';
        const dim       = type === 'context';

        return (
          <Box key={i}>
            <Text color="gray">{lineNoStr} </Text>
            <Text color={color} bold={!dim}>{prefix} </Text>
            <Text color={color}>{line}</Text>
          </Box>
        );
      })}
    </Box>
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
  const lines = output.split('\n');
  const MAX   = name === 'run_command' ? 20 : 12;
  if (lines.length <= MAX) return output;
  return lines.slice(0, MAX).join('\n') + `\n… ${lines.length - MAX} more lines`;
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n) + '…' : str;
}
