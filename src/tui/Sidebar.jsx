import React from 'react';
import { accent } from '../ui/theme.js';

// Right-hand workspace panel. Mirrors the data Axion already tracks:
// model, mode, context usage, session cost, pinned files, MCP tools, todos.
export function Sidebar({
  model = '—',
  modeIcon = '·',
  modeLabel = 'ask',
  modeColor = 'cyan',
  ctxUsed = 0,
  ctxWindow = 0,
  sessionCost = 0,
  pinnedFiles = [],
  mcpTools = 0,
  todos = [],
  width = 30,
}) {
  const A = accent();
  const pending = todos.filter(t => !t.done);
  const doneCount = todos.length - pending.length;
  const ctxPct = ctxWindow > 0 ? Math.min(100, Math.round((ctxUsed / ctxWindow) * 100)) : 0;

  return (
    <box title="workspace" titleColor={A} style={{ width, border: true, borderColor: '#444', flexDirection: 'column', paddingLeft: 1, paddingRight: 1 }}>
      <text><span fg={A}>model</span></text>
      <text>{`  ${model}`}</text>

      <text> </text>
      <text><span fg={A}>mode</span></text>
      <text><span fg={modeColor}>{`  ${modeIcon} ${modeLabel}`}</span></text>

      {ctxUsed > 0 && (
        <>
          <text> </text>
          <text><span fg={A}>context</span></text>
          <text><span fg="#888">{`  ${(ctxUsed / 1000).toFixed(1)}k / ${(ctxWindow / 1000).toFixed(0)}k · ${ctxPct}%`}</span></text>
        </>
      )}

      {sessionCost > 0 && (
        <>
          <text> </text>
          <text><span fg={A}>cost</span></text>
          <text><span fg="#888">{`  $${sessionCost.toFixed(4)}`}</span></text>
        </>
      )}

      {pinnedFiles.length > 0 && (
        <>
          <text> </text>
          <text><span fg={A}>{`pinned (${pinnedFiles.length})`}</span></text>
          {pinnedFiles.slice(0, 4).map((f, i) => (
            <text key={i}><span fg="#888">{`  ${String(f.path || f).split(/[\\/]/).pop()}`}</span></text>
          ))}
          {pinnedFiles.length > 4 && <text><span fg="#888">{`  +${pinnedFiles.length - 4} more`}</span></text>}
        </>
      )}

      {mcpTools > 0 && (
        <>
          <text> </text>
          <text><span fg={A}>mcp</span></text>
          <text><span fg="#888">{`  ${mcpTools} tools`}</span></text>
        </>
      )}

      {pending.length > 0 && (
        <>
          <text> </text>
          <text><span fg={A}>{`todo (${pending.length})`}</span></text>
          {pending.slice(0, 8).map((t, i) => (
            <text key={t.id ?? i}>{`  ☐ ${t.text}`}</text>
          ))}
          {pending.length > 8 && <text><span fg="#888">{`  +${pending.length - 8} more`}</span></text>}
          {doneCount > 0 && <text><span fg="#666">{`  ${doneCount} done`}</span></text>}
        </>
      )}
    </box>
  );
}
