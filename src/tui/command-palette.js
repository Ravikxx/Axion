import React from 'react';
import { fuzzyRankCommands } from './keymap.js';

// Fuzzy-searchable command palette — VS Code Ctrl+P style. Mirrors the
// ChatPicker layout: a filter <input> + ↑/↓ navigate · Enter dispatches ·
// Esc cancels. The parent owns navigation state (selected/query) so App's
// global useKeyboard handler drives the keys, exactly like /resume's picker.
//
// Props:
//   commands     — array of { name, slashName, description, category, onSelect }
//   total        — original command count (for the empty-state copy)
//   query        — current filter string
//   onQuery(v)   — filter input handler
//   selected     — active row index
//   onPick(i)    — Enter / click on row i
//   onHover(i)   — mouse hover row i
//   focused      — focus the filter input
//   accentColor  — theme accent
export function CommandPalette({ commands, total, query, onQuery, selected = 0, onPick, onHover, focused, accentColor = '#7ee787' }) {
  const matches = fuzzyRankCommands(commands, query);
  return (
    <box style={{ flexShrink: 0, flexDirection: 'column', border: true, borderColor: accentColor, paddingLeft: 1, paddingRight: 1 }}>
      <box style={{ flexDirection: 'row' }}>
        <text><span fg={accentColor}>{'⌘ '}</span></text>
        <input value={query} onInput={onQuery} focused={focused} placeholder="search commands…" />
      </box>
      {!total ? (
        <text><span fg="#666">No commands registered.</span></text>
      ) : !matches.length ? (
        <text><span fg="#666">No matches.</span></text>
      ) : null}
      {matches.slice(0, 12).map((c, i) => {
        const on = i === selected;
        const disp = c.slashName ? `/${c.slashName}` : c.name;
        const cat = c.category ? <span fg={on ? '#aaa' : '#555'}>{`  ${c.category}`}</span> : null;
        return (
          <box key={c.name} onMouseDown={() => onPick?.(i)} onMouseOver={() => onHover?.(i)} style={{ flexDirection: 'row' }}>
            <text>
              <span fg={on ? accentColor : '#666'}>{on ? ' ▸ ' : '   '}</span>
              <span fg={on ? '#ffffff' : '#aaa'}>{disp.padEnd(22)}</span>
              <span fg={on ? '#888' : '#555'}>{(c.description || '').slice(0, 48)}</span>
              {cat}
            </text>
          </box>
        );
      })}
      {matches.length > 12 ? <text><span fg="#666">{`  … ${matches.length - 12} more — keep typing to filter`}</span></text> : null}
      <text><span fg="#666">{'   ↑/↓ select · Enter run · Esc cancel · type to filter'}</span></text>
    </box>
  );
}