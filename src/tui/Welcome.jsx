import React from 'react';
import { accent } from '../ui/theme.js';

const MODE_ICONS = { ask: '?', plan: '◈', auto: '⚡', bypass: '⚡' };
const modeLabel = (m) => (m === 'auto' ? 'bypass' : m);

export function Welcome({ model = '—', mode = 'ask', cwd = process.cwd() }) {
  const A = accent();
  const dir = String(cwd).split(/[\\/]/).pop() || cwd;
  return (
    <box style={{ flexDirection: 'column', border: true, borderColor: A, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, marginTop: 1 }}>
      <ascii-font text="AXION" font="tiny" color={A} />
      <text><span fg="#888">by Axion Labs  ·  terminal AI coding agent</span></text>
      <box style={{ flexDirection: 'row', marginTop: 1 }}>
        <box style={{ flexDirection: 'column', flexGrow: 1 }}>
          <text><span fg="#888">model  </span><span fg={A}>{model}</span><span fg="#888">  mode  </span><span fg="#7ee787">{`${MODE_ICONS[mode] || '·'} ${modeLabel(mode)}`}</span><span fg="#888">  dir  </span><span>{dir}</span></text>
        </box>
        <box style={{ flexDirection: 'column', marginLeft: 4 }}>
          <text><span fg="#888">/help /model /theme /clear</span></text>
        </box>
      </box>
    </box>
  );
}
