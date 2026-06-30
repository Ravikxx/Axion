import React from 'react';

// File-mention picker — shown while typing `@<query>`. Mirrors SuggestionBox.
export function FilePicker({ matches, selected = 0, onPick, onHover, accentColor }) {
  if (!matches.length) return null;
  return (
    <box style={{ flexShrink: 0, flexDirection: 'column', border: true, borderColor: '#444', paddingLeft: 1, paddingRight: 1 }}>
      {matches.map((f, i) => {
        const on = i === selected;
        return (
          <box key={f} onMouseDown={() => onPick?.(i)} onMouseOver={() => onHover?.(i)} style={{ flexDirection: 'row' }}>
            <text>
              <span fg={on ? accentColor : '#666'}>{on ? ' ▸ ' : '   '}</span>
              <span fg={on ? '#ffffff' : '#888'}>{f}</span>
            </text>
          </box>
        );
      })}
      <text><span fg="#666">{'   ↑/↓ select · Tab/Enter insert · its contents are sent with your message'}</span></text>
    </box>
  );
}
