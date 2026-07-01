import React from 'react';

// Fuzzy-filterable saved-chat picker for /resume (no args). Mirrors
// FilePicker.jsx's layout/interaction — ↑/↓ or click to select, Tab/Enter to
// open the chosen chat in a new tab, Esc to cancel. Owns its own filter
// <input> (the main chat input has already been cleared by the time /resume
// is submitted, so there's no `@query`-style text to drive off of).
export function ChatPicker({ chats, total, query, onQuery, selected = 0, onPick, onHover, focused, accentColor }) {
  return (
    <box style={{ flexShrink: 0, flexDirection: 'column', border: true, borderColor: accentColor, paddingLeft: 1, paddingRight: 1 }}>
      <box style={{ flexDirection: 'row' }}>
        <text><span fg={accentColor}>{'↻ '}</span></text>
        <input value={query} onInput={onQuery} focused={focused} placeholder="filter saved chats…" />
      </box>
      {!total ? (
        <text><span fg="#666">No saved chats. Use /save {'<name>'} to save one.</span></text>
      ) : !chats.length ? (
        <text><span fg="#666">No matches.</span></text>
      ) : null}
      {chats.map((c, i) => {
        const on = i === selected;
        const when = c.savedAt ? new Date(c.savedAt).toLocaleString() : '?';
        return (
          <box key={c.name} onMouseDown={() => onPick?.(i)} onMouseOver={() => onHover?.(i)} style={{ flexDirection: 'row' }}>
            <text>
              <span fg={on ? accentColor : '#666'}>{on ? ' ▸ ' : '   '}</span>
              <span fg={on ? '#ffffff' : '#888'}>{c.name.padEnd(20)}</span>
              <span fg="#666">{` ${(c.model || '?').padEnd(14)} ${c.messages ?? '?'} msgs  ${when}`}</span>
            </text>
          </box>
        );
      })}
      <text><span fg="#666">{'   ↑/↓ select · Tab/Enter open in new tab · Esc cancel · type to filter'}</span></text>
    </box>
  );
}
