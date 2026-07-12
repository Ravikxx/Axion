import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { fuzzyFilter } from '../utils/fileList.js';
import { accent } from '../ui/theme.js';

const MAX_VISIBLE = 7;

/**
 * Ctrl+P-style message selector dialog with fuzzy search.
 * Lets users quickly navigate to any user message in the transcript.
 *
 * Props:
 * - messages: array of all messages
 * - onSelect: function(message, index) called when user picks a message
 * - onClose: close dialog
 * - accentColor: theme accent color
 */
export function MessageSelector({ messages, onSelect, onClose, accentColor }) {
  const A = accentColor || accent();

  // Filter to user messages (the ones you'd want to jump to)
  const userMessages = useMemo(() => {
    return messages
      .map((m, i) => ({ msg: m, idx: i }))
      .filter(({ msg }) => msg.type === 'user' && !msg.isMeta);
  }, [messages]);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filtered = useMemo(() => {
    if (!query.trim()) return userMessages;
    const texts = userMessages.map((e) => {
      const text = e.msg.text || '';
      return typeof text === 'string' ? text.slice(0, 200) : '';
    });
    const matches = fuzzyFilter(texts, query, MAX_VISIBLE);
    return matches.map((t) => userMessages[texts.indexOf(t)]).filter(Boolean);
  }, [userMessages, query]);

  useEffect(() => { setSelectedIndex(0); }, [query]);
  useEffect(() => {
    if (selectedIndex >= filtered.length) setSelectedIndex(Math.max(0, filtered.length - 1));
  }, [selectedIndex, filtered.length]);

  const moveUp = useCallback(() => setSelectedIndex((i) => Math.max(0, i - 1)), []);
  const moveDown = useCallback(() => setSelectedIndex((i) => Math.min(filtered.length - 1, i + 1)), [filtered.length]);
  const jumpToTop = useCallback(() => setSelectedIndex(0), []);
  const jumpToBottom = useCallback(() => setSelectedIndex(Math.max(0, filtered.length - 1)), [filtered.length]);
  const selectCurrent = useCallback(() => {
    const item = filtered[selectedIndex];
    if (item) onSelect(item.msg, item.idx);
  }, [filtered, selectedIndex, onSelect]);

  // Handle keyboard
  useEffect(() => {
    function onKey(ch, key) {
      if (key.escape) { onClose(); return; }
      if (key.name === 'up' || (key.ctrl && ch === 'p')) { moveUp(); return; }
      if (key.name === 'down' || (key.ctrl && ch === 'n')) { moveDown(); return; }
      if (key.name === 'return') { selectCurrent(); return; }
      if (key.name === 'home' || (key.ctrl && ch === 'a')) { jumpToTop(); return; }
      if (key.name === 'end' || (key.ctrl && ch === 'e')) { jumpToBottom(); return; }
    }
    // This would need to be registered via the keybinding system
    // For now, we expose the handlers for the parent to wire up
  }, [moveUp, moveDown, selectCurrent, jumpToTop, jumpToBottom, onClose]);

  const firstVisible = Math.max(0, Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), filtered.length - MAX_VISIBLE));

  return (
    <box style={{ flexDirection: 'column', border: true, borderColor: A, backgroundColor: '#1a1b1f', paddingLeft: 1, paddingRight: 1, marginBottom: 1 }}>
      <box style={{ marginBottom: 1 }}>
        <text><span fg={A}>{'Go to message'}</span></text>
      </box>
      <box style={{ flexDirection: 'row', marginBottom: 1 }}>
        <text><span fg={A}>{'🔍 '}</span></text>
        <input
          value={query}
          onInput={setQuery}
          placeholder="filter messages…"
        />
      </box>
      <box style={{ flexDirection: 'column' }}>
        {filtered.slice(firstVisible, firstVisible + MAX_VISIBLE).map((item, vi) => {
          const oi = firstVisible + vi;
          const isSelected = oi === selectedIndex;
          const text = (item.msg.text || '(empty)').slice(0, 80).replace(/\n/g, ' ');
          return (
            <box key={item.idx} style={{ flexDirection: 'row', height: 1 }}>
              <box style={{ width: 2, minWidth: 2 }}>
                <text>{isSelected ? <span fg={A}>{'▸ '}</span> : '  '}</text>
              </box>
              <text>
                <span fg={isSelected ? A : undefined} bold={isSelected}>
                  {text}
                </span>
              </text>
            </box>
          );
        })}
      </box>
      <box style={{ marginTop: 1 }}>
        <text><span fg="#666">{`Enter select · ↑/↓ navigate · Esc close`}</span></text>
      </box>
    </box>
  );
}

/**
 * Extract the first user prompt text from a message, or null.
 * Used for sticky prompt headers.
 */
export function stickyPromptText(msg) {
  if (!msg) return null;
  if (msg.type === 'user' && !msg.isMeta) {
    const text = msg.text || '';
    const trimmed = text.trimStart();
    const paraEnd = trimmed.search(/\n\s*\n/);
    const collapsed = (paraEnd >= 0 ? trimmed.slice(0, paraEnd) : trimmed).slice(0, 500).replace(/\s+/g, ' ').trim();
    return collapsed || null;
  }
  return null;
}
