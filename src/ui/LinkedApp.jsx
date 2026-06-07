import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, Static, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { WebSocket } from 'ws';
import { MessageRow } from './ChatPane.jsx';
import { InputBox, YesNoPrompt } from './Input.jsx';

// ── LinkedApp ─────────────────────────────────────────────────────────────────
// Thin ink renderer that talks to a running axion-serve instance over WebSocket.
// The server runs the agent; this component just renders events and forwards input.

export function LinkedApp({ wsUrl, initialModel, initialMode }) {
  const { exit } = useApp();

  const [model, setModel]             = useState(initialModel);
  const [mode, setMode]               = useState(initialMode);
  const [staticMessages, setStatic]   = useState([]);
  const [liveMessages, setLive]       = useState([]);
  const [streamContent, setStream]    = useState(null);
  const [thinking, setThinking]       = useState(false);
  const [thinkingWord, setWord]       = useState('');
  const [inputMode, setInputMode]     = useState('chat');
  const [pendingConfirm, setConfirm]  = useState(null);
  const [tokens, setTokens]           = useState({ total: 0, input: 0, output: 0 });
  const [connected, setConnected]     = useState(false);

  const wsRef          = useRef(null);
  const streamBuf      = useRef('');
  const streamTimer    = useRef(null);
  const rejectedRef    = useRef(false); // set true when server sends error_disconnect

  const addLive  = useCallback((m) => setLive((p) => [...p, m]), []);
  const addStatic = useCallback((m) => setStatic((p) => [...p, m]), []);

  const finalizeTurn = useCallback(() => {
    setLive((live) => {
      if (live.length) setStatic((s) => [...s, ...live]);
      return [];
    });
    setStream(null);
    streamBuf.current = '';
    if (streamTimer.current) { clearTimeout(streamTimer.current); streamTimer.current = null; }
  }, []);

  // ── Event handler (ref so it always sees fresh state setters) ───────────────

  const handleEvent = useCallback((data) => {
    switch (data.type) {
      case 'welcome':
        setConnected(true);
        if (data.model) setModel(data.model);
        if (data.mode)  setMode(data.mode);
        if (data.history?.length) {
          setStatic(data.history);
        } else {
          setStatic([{ type: '_banner', model: data.model || initialModel, mode: data.mode || initialMode, linked: true }]);
        }
        break;

      case 'message': {
        const m = data.msg;
        if (m.type === 'thinking') break; // skip extended thinking blocks in CLI view
        addLive(m);
        break;
      }

      case 'tool_call':
        addLive({ type: 'tool', id: data.id, name: data.name, input: data.input, output: null, success: null, pending: true });
        break;

      case 'tool_result':
        setLive((p) => {
          const idx = [...p].reverse().findIndex((m) => m.type === 'tool' && m.name === data.name && m.pending);
          if (idx === -1) return p;
          const ri = p.length - 1 - idx;
          const next = [...p];
          next[ri] = { ...next[ri], output: data.output, success: data.success, pending: false, diff: data.diff || null };
          return next;
        });
        break;

      case 'stream_chunk':
        streamBuf.current += data.content;
        if (!streamTimer.current) {
          streamTimer.current = setTimeout(() => {
            streamTimer.current = null;
            setStream(streamBuf.current);
          }, 30);
        }
        break;

      case 'stream_end': {
        if (streamTimer.current) { clearTimeout(streamTimer.current); streamTimer.current = null; }
        const content = streamBuf.current;
        streamBuf.current = '';
        setStream(null);
        if (content.trim()) addLive({ type: 'assistant', content });
        break;
      }

      case 'thinking_start':
        setThinking(true);
        setWord(data.word || 'thinking');
        break;

      case 'thinking_end':
        setThinking(false);
        setWord('');
        setInputMode('chat');
        setConfirm(null);
        finalizeTurn();
        break;

      case 'confirm_request':
        setConfirm(data.kind === 'tool' ? { name: data.tool?.name, label: data.tool?.label } : {});
        setInputMode(data.kind === 'tool' ? 'confirm-tool' : 'confirm-plan');
        break;

      case 'tokens':
        setTokens({ total: data.total, input: data.input, output: data.output });
        break;

      case 'status':
        if (data.model) setModel(data.model);
        if (data.mode)  setMode(data.mode);
        if (data.tokens) setTokens(data.tokens);
        break;

      case 'clear':
        setStatic([{ type: '_banner', model, mode, linked: true }]);
        setLive([]); setStream(null); streamBuf.current = '';
        break;

      case 'resume':
        setStatic(data.messages || []);
        if (data.model) setModel(data.model);
        if (data.mode)  setMode(data.mode);
        break;

      case 'error_disconnect':
        rejectedRef.current = true;
        addStatic({ type: 'error', content: data.reason || 'Cannot link: incompatible session type.' });
        setTimeout(() => exit(), 800);
        break;
    }
  }, [addLive, exit, finalizeTurn, initialModel, initialMode, model, mode]);

  // ── WebSocket connection ────────────────────────────────────────────────────

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', clientType: 'cli' }));
    });

    ws.on('message', (raw) => {
      try { handleEvent(JSON.parse(raw.toString())); } catch {}
    });

    ws.on('close', () => {
      setConnected(false);
      if (!rejectedRef.current) {
        addStatic({ type: 'error', content: 'Disconnected from web server.' });
      }
    });

    ws.on('error', (err) => {
      addStatic({ type: 'error', content: `Connection error: ${err.message}` });
    });

    return () => { try { ws.close(); } catch {} };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Send helpers ────────────────────────────────────────────────────────────

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === 1 /* OPEN */) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const handleSubmit = useCallback((input) => {
    if (!input.trim()) return;
    if (input === '/exit') { exit(); return; }
    send({ type: 'submit', content: input, clientType: 'cli' });
  }, [send, exit]);

  const handleConfirm = useCallback((answer) => {
    send({ type: 'confirm', answer });
    setInputMode('chat');
    setConfirm(null);
  }, [send]);

  // ── Token display ───────────────────────────────────────────────────────────

  const tokStr = tokens.total > 0
    ? tokens.total < 1000 ? `${tokens.total}` : `${(tokens.total / 1000).toFixed(1)}k`
    : null;

  const allMessages = [...staticMessages, ...liveMessages];

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" width="100%">
      {/* Linked-mode banner */}
      {!connected && (
        <Box paddingX={1} marginBottom={1}>
          <Text color="yellow">◈ Connecting to axion-serve at {wsUrl}…</Text>
        </Box>
      )}

      {/* Static messages */}
      <Static items={staticMessages}>
        {(msg, i) => <MessageRow key={i} msg={msg} />}
      </Static>

      {/* Live messages (current turn) */}
      {liveMessages.map((msg, i) => <MessageRow key={`live-${i}`} msg={msg} />)}

      {/* Streaming text */}
      {streamContent && (
        <MessageRow msg={{ type: 'assistant', content: streamContent, streaming: true }} />
      )}

      {/* Thinking spinner */}
      {thinking && (
        <Box paddingX={1} marginTop={1}>
          <Text color="green"><Spinner type="dots" /> </Text>
          <Text color="green">{thinkingWord}…</Text>
        </Box>
      )}

      {/* Confirm prompt */}
      {(inputMode === 'confirm-tool' || inputMode === 'confirm-plan') && pendingConfirm !== null && (
        <YesNoPrompt
          message={
            inputMode === 'confirm-tool'
              ? `Run ${pendingConfirm.name}${pendingConfirm.label ? ` (${pendingConfirm.label})` : ''}?`
              : 'Execute this plan?'
          }
          onAnswer={handleConfirm}
        />
      )}

      {/* Status bar */}
      <Box paddingX={1} marginTop={1} gap={2}>
        <Text color="blueBright" bold>◈</Text>
        <Text color="cyan">{model}</Text>
        <Text color="gray">·</Text>
        <Text color={mode === 'auto' ? 'green' : mode === 'plan' ? 'yellow' : 'cyan'}>{mode}</Text>
        {tokStr && <><Text color="gray">·</Text><Text color="gray">{tokStr} tok</Text></>}
        <Text color="gray">·</Text>
        <Text color={connected ? 'green' : 'red'}>{connected ? '● linked' : '○ disconnected'}</Text>
      </Box>

      {/* Input */}
      {inputMode === 'chat' && (
        <InputBox
          onSubmit={handleSubmit}
          disabled={thinking}
          placeholder={thinking ? `${thinkingWord}… (type /btw for a side question)` : 'ask Axion…'}
        />
      )}
    </Box>
  );
}
