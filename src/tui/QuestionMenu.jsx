import React, { useState, useEffect, useRef } from 'react';
import { useKeyboard } from '@opentui/react';
import { accent } from '../ui/theme.js';

// Interactive question menu for the ask_* tools. Renders as a filled gray panel
// (so it never visually overlaps scrollback) and walks a sequence of questions:
//   - 'choice': pick one (↑/↓ or click, Enter to confirm)
//   - 'multi':  select all that apply (Space/click toggles, Enter confirms)
//   - 'text':   type a free-form answer
// Any question may set allowCustom to add a "✎ type your own…" row.
// Calls onComplete(answers[]) with one entry per question, or onCancel().

const CUSTOM = Symbol('custom');

export function QuestionMenu({ form, isActive = true, onComplete, onCancel }) {
  const A = accent();
  const questions = form?.questions || [];
  const [idx, setIdx] = useState(0);
  const answersRef = useRef([]);
  const q = questions[idx] || {};
  const type = q.type || (q.options?.length ? 'choice' : 'text');
  const opts = q.options || [];
  const allowCustom = !!q.allowCustom;

  // Rows = options (+ optional custom row). Index into this list is the highlight.
  const rows = allowCustom ? [...opts, CUSTOM] : opts;

  const [sel, setSel] = useState(0);
  const [checked, setChecked] = useState(() => new Set());
  const [typing, setTyping] = useState(type === 'text'); // text sub-mode
  const [draft, setDraft] = useState('');
  const inputRef = useRef('');

  // Reset per-question state when moving to the next question.
  useEffect(() => {
    setSel(0);
    setChecked(new Set());
    setTyping((questions[idx]?.type || (questions[idx]?.options?.length ? 'choice' : 'text')) === 'text');
    setDraft('');
    inputRef.current = '';
  }, [idx]); // eslint-disable-line

  const commit = (answer) => {
    answersRef.current = [...answersRef.current, answer];
    if (idx + 1 < questions.length) setIdx(idx + 1);
    else onComplete?.(answersRef.current);
  };

  const submitText = (value) => {
    const v = (value ?? draft ?? '').trim();
    if (type === 'multi') {
      // custom text adds to the checked selection, then back to list
      const picked = [...checked].map((i) => opts[i]);
      commit(v ? [...picked, v] : picked);
    } else {
      commit(v);
    }
  };

  const confirmList = () => {
    const row = rows[sel];
    if (row === CUSTOM) { setTyping(true); return; }
    if (type === 'multi') {
      commit([...checked].sort((a, b) => a - b).map((i) => opts[i]));
    } else {
      commit(opts[sel]);
    }
  };

  useKeyboard((key) => {
    if (!isActive) return;
    if (key.ctrl || key.meta) return; // let the Session handle tab controls (Ctrl+T/W/1-9)
    const name = key.name;
    if (name === 'escape') {
      if (typing && type !== 'text') { setTyping(false); return; } // back to list
      onCancel?.();
      return;
    }
    if (typing) return; // the <input> owns typing + Enter
    if (!rows.length) return;
    if (name === 'up')   { setSel((s) => (s - 1 + rows.length) % rows.length); return; }
    if (name === 'down') { setSel((s) => (s + 1) % rows.length); return; }
    if (name === 'space' && type === 'multi' && rows[sel] !== CUSTOM) {
      setChecked((c) => { const n = new Set(c); n.has(sel) ? n.delete(sel) : n.add(sel); return n; });
      return;
    }
    if (name === 'return') { confirmList(); return; }
    // number keys jump-select an option
    const numMatch = /^[1-9]$/.test(name || '') ? parseInt(name, 10) - 1 : -1;
    if (numMatch >= 0 && numMatch < opts.length) {
      if (type === 'multi') setChecked((c) => { const n = new Set(c); n.has(numMatch) ? n.delete(numMatch) : n.add(numMatch); return n; });
      else { setSel(numMatch); }
      return;
    }
  });

  const stepLabel = questions.length > 1 ? `  (${idx + 1}/${questions.length})` : '';

  return (
    <box style={{ flexShrink: 0, flexDirection: 'column', backgroundColor: '#1a1b1f', border: true, borderColor: A, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, marginTop: 1 }}>
      <text>
        <span fg={A}>{'? '}</span>
        <span fg="#ffffff">{q.question || 'Answer:'}</span>
        <span fg="#666">{stepLabel}</span>
      </text>
      <text> </text>

      {!typing && rows.map((row, i) => {
        const on = i === sel;
        if (row === CUSTOM) {
          return (
            <box key="custom" onMouseDown={() => setTyping(true)} onMouseOver={() => setSel(i)} style={{ flexDirection: 'row' }}>
              <text><span fg={on ? A : '#666'}>{on ? ' ▸ ' : '   '}</span><span fg={on ? A : '#888'}>✎ type your own…</span></text>
            </box>
          );
        }
        const isChecked = checked.has(i);
        const marker = type === 'multi' ? (isChecked ? '◉ ' : '◯ ') : '';
        return (
          <box
            key={i}
            onMouseDown={() => {
              if (type === 'multi') { setChecked((c) => { const n = new Set(c); n.has(i) ? n.delete(i) : n.add(i); return n; }); setSel(i); }
              else { setSel(i); commit(opts[i]); }
            }}
            onMouseOver={() => setSel(i)}
            style={{ flexDirection: 'row' }}
          >
            <text>
              <span fg={on ? A : '#666'}>{on ? ' ▸ ' : '   '}</span>
              <span fg={isChecked ? '#7ee787' : (on ? A : '#888')}>{marker}</span>
              <span fg={on ? '#ffffff' : '#bbb'}>{`${i + 1}. ${row}`}</span>
            </text>
          </box>
        );
      })}

      {typing && (
        <box style={{ flexDirection: 'row', border: true, borderColor: A, height: 3, paddingLeft: 1, paddingRight: 1 }}>
          <input
            value={draft}
            onInput={(v) => { inputRef.current = v; setDraft(v); }}
            onSubmit={submitText}
            focused={isActive}
            placeholder={q.placeholder || 'type your answer and press Enter…'}
          />
        </box>
      )}

      <text> </text>
      <text><span fg="#666">{
        typing ? '   Enter submit · Esc cancel'
        : type === 'multi' ? '   ↑/↓ move · Space toggle · Enter confirm · Esc cancel'
        : '   ↑/↓ or click · Enter select · Esc cancel'
      }</span></text>
    </box>
  );
}
