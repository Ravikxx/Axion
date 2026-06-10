import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

export function InputBox({ onSubmit, disabled, placeholder, onChange, tabCompletion, onToggleExpand, onToggleThinking, onCycleMode }) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [draft, setDraft] = useState(''); // preserves in-progress text while browsing history

  const isActive = process.stdin.isTTY !== false;

  // Notify parent of value changes for autocomplete
  useEffect(() => { onChange?.(value); }, [value]);

  useInput(
    (input, key) => {
      if (disabled) return;

      if (key.return) {
        const trimmed = value.trim();
        if (!trimmed) return;
        setHistory((h) => [...h, trimmed]);
        setHistoryIdx(-1);
        setDraft('');
        setValue('');
        onChange?.('');
        onSubmit(trimmed);
        return;
      }

      // Tab — complete the top suggestion
      if (key.tab && tabCompletion) {
        setValue(tabCompletion);
        return;
      }

      if (key.upArrow) {
        if (!history.length) return;
        if (historyIdx === -1) setDraft(value); // save what's being typed
        const newIdx = Math.min(historyIdx + 1, history.length - 1);
        setHistoryIdx(newIdx);
        setValue(history[history.length - 1 - newIdx] || '');
        return;
      }

      if (key.downArrow) {
        if (historyIdx === -1) return;
        const newIdx = Math.max(historyIdx - 1, -1);
        setHistoryIdx(newIdx);
        setValue(newIdx === -1 ? draft : history[history.length - 1 - newIdx] || '');
        return;
      }

      // Esc — clear the input (or exit history browsing back to draft)
      if (key.escape) {
        setHistoryIdx(-1);
        setDraft('');
        setValue('');
        return;
      }

      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1));
        return;
      }

      if (key.ctrl && input === 'c') process.exit(0);
      if (key.ctrl && input === 'e') { onToggleExpand?.();   return; }
      if (key.ctrl && input === 't') { onToggleThinking?.(); return; }
      if (key.ctrl && input === 'p') { onCycleMode?.();      return; }

      if (!key.ctrl && !key.meta && input) {
        if (historyIdx !== -1) setHistoryIdx(-1); // editing a recalled entry starts a new draft
        setValue((v) => v + input);
      }
    },
    { isActive }
  );

  const isCmd = value.startsWith('/');
  const borderColor = disabled ? 'gray' : isCmd ? 'yellow' : 'blueBright';
  const promptColor = disabled ? 'gray' : isCmd ? 'yellow' : 'blueBright';

  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} marginX={1} marginTop={0}>
      <Text color={promptColor} bold>{'›'} </Text>
      {value
        ? <Text color="white">{value}</Text>
        : <Text color="gray" dimColor>{placeholder || ''}</Text>
      }
      {!disabled && <Text color={promptColor}>▋</Text>}
    </Box>
  );
}

export function YesNoPrompt({ onAnswer }) {
  const isActive = process.stdin.isTTY !== false;
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === 'y' || key.return) onAnswer(true);
    else if (ch === 'n') onAnswer(false);
  }, { isActive });
  return null;
}
