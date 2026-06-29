import React from 'react';
import { accent } from '../ui/theme.js';

const MODE_ICONS = { ask: '?', plan: '◈', auto: '⚡', bypass: '⚡' };
const modeLabel = (m) => (m === 'auto' ? 'bypass' : m);

// Startup welcome banner — brand + current model/mode/dir on the left, a quick
// reference for the commands that work in the new UI on the right.
export function Welcome({ model = '—', mode = 'ask', cwd = process.cwd() }) {
  const A = accent();
  const dir = String(cwd).split(/[\\/]/).pop() || cwd;
  return (
    <box style={{ flexDirection: 'row', border: true, borderColor: A, paddingLeft: 2, paddingRight: 2, marginTop: 1, marginLeft: 1, alignSelf: 'flex-start' }}>
      {/* Left: brand + status */}
      <box style={{ flexDirection: 'column', marginRight: 4 }}>
        <text><span fg={A}>✻ Axion</span><span fg="#888">  by Axion Labs</span></text>
        <text><span fg="#888">  model  </span><span fg={A}>{model}</span></text>
        <text><span fg="#888">  mode   </span><span fg="#7ee787">{`${MODE_ICONS[mode] || '·'} ${modeLabel(mode)}`}</span></text>
        <text><span fg="#888">{`  dir    ${dir}`}</span></text>
      </box>
      {/* Right: quick start */}
      <box style={{ flexDirection: 'column' }}>
        <text><span fg="#f0c674">Quick start</span></text>
        <text><span>  /help</span><span fg="#888">          all commands</span></text>
        <text><span>  /model /mode</span><span fg="#888">   switch model · mode</span></text>
        <text><span>  /theme</span><span fg="#888">         change accent color</span></text>
        <text><span>  /clear</span><span fg="#888">         start a new conversation</span></text>
        <text><span fg="#888">  PageUp/Down · wheel</span><span fg="#888">  scroll history</span></text>
      </box>
    </box>
  );
}
