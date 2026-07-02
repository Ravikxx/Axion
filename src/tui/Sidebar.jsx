import React from 'react';
import { accent } from '../ui/theme.js';

const fmtCtx = (n) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${(n / 1000).toFixed(0)}k`;

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
  diffTotals = { added: 0, removed: 0 },
  gitInfo = null,
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
    <box style={{ width, backgroundColor: '#1a1b1f', flexDirection: 'column', paddingLeft: 2, paddingRight: 1, paddingTop: 1 }}>
      <text><span fg={A}>✻ workspace</span></text>
      <text> </text>
      <text><span fg={A}>model</span></text>
      <text>{`  ${model}`}</text>
      <text><span fg="#888">{`  ${fmtCtx(ctxWindow)} context`}</span></text>

      <text> </text>
      <text><span fg={A}>mode</span></text>
      <text><span fg={modeColor}>{`  ${modeIcon} ${modeLabel}`}</span></text>

      {ctxUsed > 0 && (
        <>
          <text> </text>
          <text><span fg={A}>context</span></text>
          {(() => {
            // Colored usage bar: green → yellow (60%) → red (85%).
            const barW = Math.max(10, width - 8);
            const filled = Math.min(barW, Math.round((ctxPct / 100) * barW));
            const barColor = ctxPct >= 85 ? '#f85149' : ctxPct >= 60 ? '#f0c674' : '#7ee787';
            return (
              <>
                <text>
                  <span fg={barColor}>{'  ' + '█'.repeat(filled)}</span>
                  <span fg="#333">{'░'.repeat(barW - filled)}</span>
                </text>
                <text><span fg="#888">{`  ${(ctxUsed / 1000).toFixed(1)}k / ${fmtCtx(ctxWindow)} · `}</span><span fg={barColor}>{`${ctxPct}%`}</span></text>
                {ctxPct >= 85 ? <text><span fg="#f85149">{'  ⚠ run /compact soon'}</span></text> : null}
              </>
            );
          })()}
        </>
      )}

      {sessionCost > 0 && (
        <>
          <text> </text>
          <text><span fg={A}>cost</span></text>
          <text><span fg="#888">{`  $${sessionCost.toFixed(4)}`}</span></text>
        </>
      )}

      {(diffTotals.added > 0 || diffTotals.removed > 0) && (
        <>
          <text> </text>
          <text><span fg={A}>diff</span></text>
          <text>
            <span fg="#7ee787">{`  +${diffTotals.added}`}</span>
            <span fg="#f85149">{`  -${diffTotals.removed}`}</span>
          </text>
        </>
      )}

      {gitInfo && (
        <>
          <text> </text>
          <text><span fg={A}>git</span></text>
          <text><span fg="#888">{`  ${gitInfo.branch}`}</span></text>
          {(gitInfo.staged > 0 || gitInfo.unstaged > 0) && (
            <text>
              {gitInfo.staged > 0 ? <span fg="#7ee787">{`  ${gitInfo.staged} staged`}</span> : null}
              {gitInfo.unstaged > 0 ? <span fg="#f0c674">{`  ${gitInfo.unstaged} unstaged`}</span> : null}
            </text>
          )}
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
