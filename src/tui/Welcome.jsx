import React from 'react';
import { accent } from '../ui/theme.js';

const MODE_ICONS = { ask: '?', plan: '◈', auto: '⚡', bypass: '⚡' };
const modeLabel = (m) => (m === 'auto' ? 'bypass' : m);

// Startup welcome banner — big ASCII wordmark, then current model/mode/dir and a
// quick reference for the commands that work in the new UI.
export function Welcome({ model = '—', mode = 'ask', cwd = process.cwd() }) {
  const A = accent();
  const dir = String(cwd).split(/[\\/]/).pop() || cwd;
  return (
    <box style={{ flexDirection: 'column', border: true, borderColor: A, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, marginTop: 1, marginLeft: 1, alignSelf: 'flex-start' }}>
      <ascii-font text="AXION" font="tiny" color={A} />
      <text><span fg="#888">by Axion Labs  ·  terminal AI coding agent</span></text>
      <text> </text>
      <box style={{ flexDirection: 'row' }}>
        {/* Status */}
        <box style={{ flexDirection: 'column', marginRight: 5 }}>
          <text><span fg="#888">model  </span><span fg={A}>{model}</span></text>
          <text><span fg="#888">mode   </span><span fg="#7ee787">{`${MODE_ICONS[mode] || '·'} ${modeLabel(mode)}`}</span></text>
          <text><span fg="#888">{`dir    ${dir}`}</span></text>
        </box>
        {/* Quick start */}
        <box style={{ flexDirection: 'column' }}>
          <text><span fg="#f0c674">Quick start</span></text>
          <text><span>  /help</span><span fg="#888">          all commands</span></text>
          <text><span>  /model /mode</span><span fg="#888">   switch model · mode</span></text>
          <text><span>  /theme</span><span fg="#888">         change accent color</span></text>
          <text><span>  /clear</span><span fg="#888">         start a new conversation</span></text>
          <text><span fg="#888">  PageUp/Down · wheel</span><span fg="#888">  scroll history</span></text>
        </box>
      </box>
    </box>
  );
}
