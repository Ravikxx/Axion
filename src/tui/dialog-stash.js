import React, { useState, useMemo, useRef, useEffect } from 'react';

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function StashDialog({ stashes, selected, accentColor, onSelect, onRestore, onDelete, onClose }) {
  const refs = useRef([]);
  useEffect(() => {
    try { refs.current[selected]?.scrollIntoView?.({ block: 'nearest' }); } catch {}
  }, [selected]);

  if (!stashes.length) {
    return (
      <box style={{ flexShrink: 0, paddingLeft: 1, paddingRight: 1, border: true, borderColor: '#444' }}>
        <text><span fg="#888">Stash is empty. Press Ctrl+S to stash the current prompt.</span></text>
      </box>
    );
  }

  const preview = (text) => {
    const s = (text || '').replace(/\n/g, ' ').trim();
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  };

  return (
    <box style={{ flexShrink: 0, flexDirection: 'column', border: true, borderColor: '#444', maxHeight: 12 }}>
      <box style={{ paddingLeft: 1 }}>
        <text><span fg={accentColor}>Stashed prompts  </span><span fg="#666">(↑↓ navigate · Enter restore · Del delete · Esc close)</span></text>
      </box>
      <box style={{ flexDirection: 'column', paddingLeft: 1 }}>
        {stashes.map((s, i) => (
          <box
            key={i}
            ref={el => refs.current[i] = el}
            style={{
              flexDirection: 'row',
              backgroundColor: i === selected ? '#2a2c33' : undefined,
            }}
          >
            <text>
              <span fg={i === selected ? accentColor : '#888'}>{i + 1}.</span>
              {' '}
              <span fg={i === selected ? '#fff' : '#ccc'}>{preview(s.text)}</span>
              <span fg="#666">{'  '}{timeAgo(s.stashedAt)}</span>
            </text>
          </box>
        ))}
      </box>
    </box>
  );
}
