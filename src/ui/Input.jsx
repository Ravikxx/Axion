import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { loadInputHistory, appendInputHistory } from '../persist.js';

export function InputBox({
  onSubmit, disabled, placeholder, onChange, tabCompletion,
  onToggleExpand, onToggleThinking, onCycleMode,
  onInterrupt, interruptActive, voiceActive,
}) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState(() => loadInputHistory());
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [draft, setDraft] = useState(''); // preserves in-progress text while browsing history
  const [search, setSearch] = useState(null); // Ctrl+R reverse search: { query, pos } | null

  const isActive = process.stdin.isTTY !== false;

  // Matches for the active reverse search, most recent first
  const searchMatches = search
    ? history.filter((h) => h.includes(search.query)).reverse()
    : [];
  const searchMatch = search
    ? searchMatches[Math.min(search.pos, Math.max(0, searchMatches.length - 1))] ?? null
    : null;

  // Notify parent of value changes for autocomplete
  useEffect(() => { onChange?.(value); }, [value]);

  const set = (v, c) => { setValue(v); setCursor(Math.max(0, Math.min(c, v.length))); };

  useInput(
    (input, key) => {
      // Esc interrupts a running agent turn even while "disabled" isn't set
      if (key.escape && interruptActive) { onInterrupt?.(); return; }

      if (disabled) return;

      // Reverse history search mode (Ctrl+R) — handles all keys until exited
      if (search) {
        if (key.ctrl && input === 'r') {
          // Cycle to next-older match
          setSearch((s) => ({ ...s, pos: Math.min(s.pos + 1, Math.max(0, searchMatches.length - 1)) }));
          return;
        }
        if (key.escape || (key.ctrl && (input === 'c' || input === 'g'))) {
          setSearch(null); // cancel — keep whatever was being typed before
          return;
        }
        if (key.backspace || key.delete) {
          setSearch((s) => ({ query: s.query.slice(0, -1), pos: 0 }));
          return;
        }
        if (key.return || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) {
          // Accept the current match into the input line (press Enter again to submit)
          if (searchMatch) { setHistoryIdx(-1); set(searchMatch, searchMatch.length); }
          setSearch(null);
          return;
        }
        if (!key.ctrl && !key.meta && input) {
          setSearch((s) => ({ query: s.query + input, pos: 0 }));
        }
        return;
      }

      if (key.return) {
        // Voice mode: Enter stops recording even with empty input
        if (voiceActive) {
          set('', 0);
          onChange?.('');
          onSubmit('');
          return;
        }
        // Trailing backslash before the cursor → newline instead of submit
        if (value[cursor - 1] === '\\') {
          set(value.slice(0, cursor - 1) + '\n' + value.slice(cursor), cursor);
          return;
        }
        const trimmed = value.trim();
        if (!trimmed) return;
        setHistory((h) => [...h.filter((l) => l !== trimmed), trimmed]);
        appendInputHistory(trimmed);
        setHistoryIdx(-1);
        setDraft('');
        set('', 0);
        onChange?.('');
        onSubmit(trimmed);
        return;
      }

      // Esc — clear the input (or exit history browsing back to a fresh line)
      if (key.escape) {
        setHistoryIdx(-1);
        setDraft('');
        set('', 0);
        return;
      }

      // Tab — complete the top suggestion
      if (key.tab && tabCompletion) {
        set(tabCompletion, tabCompletion.length);
        return;
      }

      if (key.leftArrow)  { setCursor((c) => Math.max(0, c - 1)); return; }
      if (key.rightArrow) { setCursor((c) => Math.min(value.length, c + 1)); return; }

      // Up/down move between lines in a multi-line draft; otherwise browse history
      const multiline = value.includes('\n');

      if (key.upArrow) {
        if (multiline) {
          const lineStart = value.lastIndexOf('\n', cursor - 1) + 1;
          if (lineStart === 0) return; // already on first line
          const col       = cursor - lineStart;
          const prevStart = value.lastIndexOf('\n', lineStart - 2) + 1;
          const prevLen   = lineStart - 1 - prevStart;
          setCursor(prevStart + Math.min(col, prevLen));
          return;
        }
        if (!history.length) return;
        if (historyIdx === -1) setDraft(value); // save what's being typed
        const newIdx = Math.min(historyIdx + 1, history.length - 1);
        const recalled = history[history.length - 1 - newIdx] || '';
        setHistoryIdx(newIdx);
        set(recalled, recalled.length);
        return;
      }

      if (key.downArrow) {
        if (multiline) {
          const lineEnd = value.indexOf('\n', cursor);
          if (lineEnd === -1) return; // already on last line
          const lineStart = value.lastIndexOf('\n', cursor - 1) + 1;
          const col       = cursor - lineStart;
          const nextStart = lineEnd + 1;
          const nextEnd   = value.indexOf('\n', nextStart);
          const nextLen   = (nextEnd === -1 ? value.length : nextEnd) - nextStart;
          setCursor(nextStart + Math.min(col, nextLen));
          return;
        }
        if (historyIdx === -1) return;
        const newIdx = Math.max(historyIdx - 1, -1);
        const next = newIdx === -1 ? draft : history[history.length - 1 - newIdx] || '';
        setHistoryIdx(newIdx);
        set(next, next.length);
        return;
      }

      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        return;
      }

      if (key.ctrl) {
        switch (input) {
          case 'c': process.exit(0); return;
          case 'a': setCursor(value.lastIndexOf('\n', cursor - 1) + 1); return; // start of line
          case 'e': {                                                           // end of line
            const e = value.indexOf('\n', cursor);
            setCursor(e === -1 ? value.length : e);
            return;
          }
          case 'u': set('', 0); return;                                // clear line
          case 'k': set(value.slice(0, cursor), cursor); return;       // kill to end
          case 'w': {                                                  // delete word before cursor
            const left = value.slice(0, cursor).replace(/\S+\s*$/, '');
            set(left + value.slice(cursor), left.length);
            return;
          }
          case 'r': setSearch({ query: '', pos: 0 }); return;       // reverse history search
          case 'o': onToggleExpand?.();   return;
          case 't': onToggleThinking?.(); return;
          case 'p': onCycleMode?.();      return;
          default: return;
        }
      }

      if (!key.meta && input) {
        if (historyIdx !== -1) setHistoryIdx(-1); // editing a recalled entry starts a new draft
        // Pasted text arrives as one chunk; terminals send \r for its newlines
        const text = input.replace(/\r\n?/g, '\n');
        set(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
      }
    },
    { isActive }
  );

  const isCmd = value.startsWith('/');
  const borderColor = disabled ? 'gray' : search ? 'magenta' : isCmd ? 'yellow' : 'blueBright';
  const promptColor = disabled ? 'gray' : search ? 'magenta' : isCmd ? 'yellow' : 'blueBright';

  if (search) {
    return (
      <Box borderStyle="round" borderColor={borderColor} paddingX={1} marginX={1} marginTop={0}>
        <Text color="magenta">(reverse-i-search) `{search.query}`: </Text>
        {searchMatch
          ? <Text color="white">{searchMatch}</Text>
          : <Text color="gray">{search.query ? 'no match' : 'type to search history'}</Text>}
      </Box>
    );
  }

  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} marginX={1} marginTop={0}>
      <Text color={promptColor} bold>{'›'} </Text>
      {value ? (
        <Text>
          <Text color="white">{value.slice(0, cursor)}</Text>
          {/* Cursor on a newline renders as a block at end-of-line, keeping the \n */}
          {!disabled && <Text inverse color="white">{value[cursor] === '\n' ? ' ' : value[cursor] ?? ' '}</Text>}
          <Text color="white">{value[cursor] === '\n' ? value.slice(cursor) : value.slice(cursor + 1)}</Text>
        </Text>
      ) : (
        <Text>
          {!disabled && <Text inverse color="white"> </Text>}
          <Text color="gray">{placeholder || ''}</Text>
        </Text>
      )}
    </Box>
  );
}

export function YesNoPrompt({ onAnswer }) {
  const isActive = process.stdin.isTTY !== false;
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === 'y' || key.return) onAnswer(true);
    else if (ch === 'a') onAnswer('always');
    else if (ch === 'n' || key.escape) onAnswer(false);
  }, { isActive });
  return null;
}
