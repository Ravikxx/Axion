import React from 'react';
import { getSuggestions } from '../ui/commands.js';

// OpenTUI slash-command menu — shows matching commands as you type `/`.
export function SuggestionBox({ inputValue }) {
  const matches = getSuggestions(inputValue);
  if (!matches.length) return null;
  const query = inputValue.slice(1).split(' ')[0];

  return (
    <box style={{ flexDirection: 'column', border: true, borderColor: '#444', paddingLeft: 1, paddingRight: 1 }}>
      {matches.slice(0, 6).map((s, i) => (
        <text key={s.cmd}>
          <span fg={i === 0 ? '#f0c674' : '#888'}>{`/${s.cmd}`}</span>
          <span fg="#888">{`  ${s.desc}`}</span>
          {i === 0 && matches.length > 1 && query !== s.cmd ? <span fg="#666">{'   tab to complete'}</span> : null}
        </text>
      ))}
      {matches.length > 6 ? <text><span fg="#666">{`  … ${matches.length - 6} more — keep typing to filter`}</span></text> : null}
    </box>
  );
}
