import React, { useState, useEffect } from 'react';

// Animated "thinking" indicator: braille spinner + whimsical verb + elapsed
// time (Xh Xm Xs) + token count. Shown while the agent is working.

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function fmtElapsed(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

function fmtTokens(n) {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function Thinking({ word = 'thinking', elapsed = 0, tokens = 0 }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);

  return (
    <box style={{ paddingLeft: 2, marginTop: 0 }}>
      <text>
        <span fg="#7ee787">{FRAMES[frame]} </span>
        <span fg="#7ee787">{word}…</span>
        <span fg="#888">{`   ${fmtElapsed(elapsed)}`}</span>
        <span fg="#888">{`  ·  ${fmtTokens(tokens)} tokens`}</span>
        <span fg="#666">{'  ·  Esc to stop'}</span>
      </text>
    </box>
  );
}
