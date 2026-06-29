import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { accent, THEMES, setTheme, themeName } from '../ui/theme.js';
import { Agent } from '../agent/agent.js';
import { MODELS, getContextWindow, estimateCost } from '../config.js';
import { getTodos, saveModel, saveMode, saveTheme } from '../persist.js';
import { COMMANDS, getTabCompletion } from '../ui/commands.js';
import { Sidebar } from './Sidebar.jsx';
import { RichText } from './RichText.jsx';
import { ToolBlock } from './ToolBlock.jsx';
import { SuggestionBox } from './Suggestions.jsx';

// ── Milestone 2: real agent wired into the OpenTUI shell ────────────────────────
// Reuses the UI-agnostic Agent class (callbacks → message list). Row layout:
// scrollable message pane + framed input on the left, workspace sidebar on right.
// NOTE (preview): tool confirms / question prompts are auto-approved for now —
// the real prompt UI is a later milestone. Shipped `axion` stays on Ink until parity.

const MODE_ICONS  = { ask: '?', plan: '◈', auto: '⚡', bypass: '⚡' };
const MODE_COLORS = { ask: 'cyan', plan: 'yellow', auto: '#7ee787', bypass: '#7ee787' };
const modeLabel = (m) => (m === 'auto' ? 'bypass' : m);

function MessageRow({ msg }) {
  const A = accent();
  switch (msg.type) {
    case 'user':
      return (
        <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text><span fg="#b08869">you</span></text>
          {(msg.text || ' ').split('\n').map((l, i) => <text key={i}>{l}</text>)}
        </box>
      );
    case 'assistant':
      return (
        <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text><span fg={A}>✻ Axion</span></text>
          <RichText>{msg.text || ' '}</RichText>
        </box>
      );
    case 'thinking':
      return (
        <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text><span fg="#a371f7">◈ thinking</span></text>
          {(msg.text || '').split('\n').slice(0, 1).map((l, i) => <text key={i}><span fg="#a371f7">{l.slice(0, 100)}</span></text>)}
        </box>
      );
    case 'tool':
      return (
        <box style={{ flexDirection: 'column', marginTop: 1 }}>
          <ToolBlock
            name={msg.name}
            input={msg.input}
            output={msg.output}
            success={msg.success}
            pending={msg.pending}
            diff={msg.diff || null}
          />
        </box>
      );
    case 'error':
      return (
        <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text><span fg="red">✖ {msg.text}</span></text>
        </box>
      );
    case 'plan':
      return (
        <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text><span fg="yellow">◈ Plan</span></text>
          <RichText>{msg.text || ' '}</RichText>
        </box>
      );
    case 'info':
      return (
        <box style={{ marginTop: 0, paddingLeft: 1, paddingRight: 1 }}>
          <text><span fg="#888">{msg.text}</span></text>
        </box>
      );
    default:
      return null;
  }
}

export function App({ initialModel = 'lumen', initialMode = 'ask' }) {
  const { width, height } = useTerminalDimensions();
  const A = accent();

  const [model, setModel] = useState(initialModel);
  const [mode, setMode]   = useState(initialMode);
  const [messages, setMessages] = useState([
    { type: 'info', text: 'Axion on OpenTUI — type a message and press Enter. Ctrl+C to quit.' },
  ]);
  const [streamText, setStreamText] = useState(null); // live streaming assistant text
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState({ total: 0, input: 0, output: 0, context: 0 });
  const [todos, setTodos] = useState(getTodos);

  const agentRef  = useRef(null);
  const streamRef = useRef('');
  const flushTimer = useRef(null);
  const inputRef  = useRef('');

  const push = useCallback((msg) => setMessages((m) => [...m, msg]), []);
  const setInputSafe = useCallback((v) => { inputRef.current = v; setInput(v); }, []);

  // Throttled flush of streaming text to state.
  const flushStream = useCallback(() => {
    flushTimer.current = null;
    setStreamText(streamRef.current);
  }, []);

  // ── Init the agent once ───────────────────────────────────────────────────────
  useEffect(() => {
    const agent = new Agent({
      modelAlias: initialModel,
      mode: initialMode,
      onTokens: (t) => setTokens(typeof t === 'object' ? t : { total: t, input: 0, output: t, context: t }),
      onStreamChunk: (chunk) => {
        streamRef.current += chunk;
        if (!flushTimer.current) flushTimer.current = setTimeout(flushStream, 30);
      },
      onStreamEnd: () => {
        if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
        streamRef.current = '';
        setStreamText(null);
      },
      onToolCall: ({ name, input, id }) => push({ type: 'tool', id, name, input, pending: true }),
      onToolResult: ({ id, name, output, success, diff }) => {
        setMessages((m) => {
          let ri = id != null ? m.findIndex((x) => x.type === 'tool' && x.id === id && x.pending) : -1;
          if (ri === -1) ri = m.findIndex((x) => x.type === 'tool' && x.name === name && x.pending);
          if (ri === -1) return m;
          const copy = m.slice();
          copy[ri] = { ...copy[ri], output, success, diff: diff || null, pending: false };
          return copy;
        });
      },
      onMessage: ({ role, content }) => {
        if (role === 'assistant')      push({ type: 'assistant', text: content });
        else if (role === 'thinking')  push({ type: 'thinking', text: content });
        else if (role === 'plan')      push({ type: 'plan', text: content });
        else if (role === 'error')     push({ type: 'error', text: content });
      },
    });
    agentRef.current = agent;
    return () => { try { agent.cancel(); } catch {} };
  }, [initialModel, initialMode, push, flushStream]);

  // Refresh todos periodically (the agent can add them via tools).
  useEffect(() => {
    const id = setInterval(() => setTodos(getTodos()), 2000);
    return () => clearInterval(id);
  }, []);

  // Ctrl+C exits (OpenTUI). Esc interrupts a running turn. Tab completes a slash command.
  useKeyboard((key) => {
    if (key.name === 'escape' && busy) { try { agentRef.current?.cancel(); } catch {} return; }
    if (key.name === 'tab' && inputRef.current.startsWith('/')) {
      const completed = getTabCompletion(inputRef.current);
      if (completed) setInputSafe(completed);
    }
  });

  // ── Slash commands (essential set; others report "coming soon") ─────────────────
  const runCommand = useCallback((raw) => {
    const [cmd, ...rest] = raw.slice(1).trim().split(/\s+/);
    const arg = rest.join(' ').trim();
    const c = (cmd || '').toLowerCase();
    switch (c) {
      case 'exit': case 'quit':
        process.exit(0);
        return;
      case 'clear':
        try { agentRef.current?.clearHistory(); } catch {}
        setMessages([{ type: 'info', text: 'Conversation cleared.' }]);
        setTokens({ total: 0, input: 0, output: 0, context: 0 });
        return;
      case 'help':
        push({ type: 'info', text: 'Commands:\n' + COMMANDS.map((x) => `  /${x.cmd}  —  ${x.desc}`).join('\n') });
        return;
      case 'models':
        push({ type: 'info', text: `Models: ${Object.keys(MODELS).join(' · ')}` });
        return;
      case 'model': {
        if (!arg) { push({ type: 'info', text: `current model: ${model}` }); return; }
        if (!MODELS[arg] && !arg.includes('/')) { push({ type: 'error', text: `Unknown model "${arg}". /models to list.` }); return; }
        setModel(arg); agentRef.current?.setModel(arg); try { saveModel(arg); } catch {}
        push({ type: 'info', text: `model → ${arg}` });
        return;
      }
      case 'mode': {
        if (!arg) { push({ type: 'info', text: `current mode: ${modeLabel(mode)}` }); return; }
        if (!['ask', 'plan', 'auto', 'bypass'].includes(arg)) { push({ type: 'error', text: 'Mode must be ask | plan | bypass.' }); return; }
        const norm = arg === 'bypass' ? 'auto' : arg;
        setMode(norm); agentRef.current?.setMode(norm); try { saveMode(norm); } catch {}
        push({ type: 'info', text: `mode → ${modeLabel(norm)}` });
        return;
      }
      case 'theme': {
        if (!arg) { push({ type: 'info', text: `themes: ${Object.keys(THEMES).join(' · ')}  (current: ${themeName()})` }); return; }
        if (!setTheme(arg)) { push({ type: 'error', text: `Unknown theme "${arg}". Options: ${Object.keys(THEMES).join(', ')}` }); return; }
        try { saveTheme(arg); } catch {}
        push({ type: 'info', text: `theme → ${arg}` });
        return;
      }
      case 'cost': {
        const inTok = tokens.input || 0, outTok = tokens.output || 0;
        const cost = estimateCost(model, inTok, outTok);
        push({ type: 'info', text: `tokens: ${tokens.total || 0}  (in ${inTok} / out ${outTok}) · est. cost ${cost ? '$' + cost.toFixed(4) : '$0.00'}` });
        return;
      }
      default:
        push({ type: 'info', text: `/${c} isn't wired into the new UI yet — coming soon. (Full command set lives in the Ink version on master.)` });
        return;
    }
  }, [model, mode, tokens, push]);

  const submit = useCallback((value) => {
    const text = (value || '').trim();
    if (!text || busy) return;
    setInputSafe('');
    if (text.startsWith('/')) { runCommand(text); return; }
    push({ type: 'user', text });
    setBusy(true);

    // Preview: auto-approve confirmations; real prompt UI is a later milestone.
    const askConfirm = () => Promise.resolve(true);
    const askPlanConfirm = () => Promise.resolve(true);
    const askUser = () => Promise.resolve('');

    agentRef.current
      .run(text, { askConfirm, askPlanConfirm, askUser })
      .catch((err) => push({ type: 'error', text: err?.message || String(err) }))
      .finally(() => setBusy(false));
  }, [busy, push, runCommand, setInputSafe]);

  const ctxWindow = getContextWindow(model) || 0;
  const ctxUsed = tokens.context || tokens.total || 0;

  return (
    <box style={{ width, height, flexDirection: 'row' }}>
      <box style={{ flexGrow: 1, flexDirection: 'column' }}>
        <scrollbox style={{ flexGrow: 1 }} focused stickyScroll stickyStart="bottom">
          {messages.map((msg, i) => <MessageRow key={i} msg={msg} />)}
          {streamText !== null && (
            <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}>
              <text><span fg={A}>✻ Axion</span></text>
              {(streamText || ' ').split('\n').map((l, i) => <text key={i}>{l}</text>)}
            </box>
          )}
        </scrollbox>
        {input.startsWith('/') && <SuggestionBox inputValue={input} />}
        <box style={{ border: true, borderColor: A, height: 3, paddingLeft: 1, paddingRight: 1 }}>
          <input
            value={input}
            onInput={setInputSafe}
            onSubmit={submit}
            focused
            placeholder={busy ? 'Axion is working…  (Esc to interrupt)' : 'ask Axion something…  (Enter to send · / for commands · Ctrl+C to quit)'}
          />
        </box>
      </box>

      <Sidebar
        model={model}
        modeIcon={MODE_ICONS[mode] || '·'}
        modeLabel={modeLabel(mode)}
        modeColor={MODE_COLORS[mode] || 'cyan'}
        ctxUsed={ctxUsed}
        ctxWindow={ctxWindow}
        todos={todos}
      />
    </box>
  );
}
