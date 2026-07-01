import React from 'react';

// Ctrl+F transcript search bar. Typing filters messages (see messageSearchText
// in App.jsx); ↑/↓ or Enter step through matches, Esc closes.
export function SearchBar({ query, onQuery, onSubmit, matchCount, current, focused, accentColor }) {
  return (
    <box style={{ flexShrink: 0, flexDirection: 'column', backgroundColor: '#1a1b1f', border: true, borderColor: accentColor, paddingLeft: 1, paddingRight: 1 }}>
      <box style={{ flexDirection: 'row' }}>
        <text><span fg={accentColor}>{'🔍 '}</span></text>
        <input value={query} onInput={onQuery} onSubmit={onSubmit} focused={focused} placeholder="search transcript…" />
      </box>
      <text>
        <span fg="#666">{
          matchCount > 0 ? `   ${current}/${matchCount} matches` : (query ? '   no matches' : '   type to search')
        }</span>
        <span fg="#444">{'   ·   ↑/↓ or Enter next · Esc close'}</span>
      </text>
    </box>
  );
}
