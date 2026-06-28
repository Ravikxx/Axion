import React, { useState, useEffect } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { accent } from '../ui/theme.js';
import { Sidebar } from './Sidebar.jsx';

// ── Milestone 1 shell ──────────────────────────────────────────────────────────
// Real OpenTUI UI structure for Axion: row layout with a scrollable message pane +
// framed input on the left, and the workspace sidebar on the right. Wired to demo
// state for now (echo + simulated streaming) — the agent/logic gets wired next.

const MODE_ICONS = { ask: '?', plan: '◈', auto: '⚡', bypass: '⚡' };
const MODE_COLORS = { ask: 'cyan', plan: 'yellow', auto: '#7ee787', bypass: '#7ee787' };

function MessageRow({ msg }) {
  const A = accent();
  const isUser = msg.role === 'user';
  const label = isUser ? 'you' : '✻ Axion';
  const labelColor = isUser ? '#b08869' : A;
  return (
    <box style={{ flexDirection: 'column', marginBottom: 1, paddingLeft: 1, paddingRight: 1 }}>
      <text><span fg={labelColor}>{label}</span></text>
      {(msg.text || ' ').split('\n').map((line, i) => (
        <text key={i}>{line}</text>
      ))}
    </box>
  );
}

export function App() {
  const { width, height } = useTerminalDimensions();
  const A = accent();
  const [model] = useState('lumen');
  const [mode] = useState('auto');
  const [messages, setMessages] = useState([
    { role: 'assistant', text: 'Axion is now running on OpenTUI.\nType a message and press Enter — replies stream in. Scroll with the wheel or arrows. Esc quits.' },
  ]);
  const [input, setInput] = useState('');
  const [clock, setClock] = useState(0);

  useKeyboard((key) => { if (key.name === 'escape') process.exit(0); });
  useEffect(() => { const id = setInterval(() => setClock(c => c + 1), 1000); return () => clearInterval(id); }, []);

  const submit = (value) => {
    if (!value || !value.trim()) return;
    setInput('');
    setMessages(m => [...m, { role: 'user', text: value }, { role: 'assistant', text: '' }]);
    const full = `You said: "${value.trim()}". This reply is streamed character by character to confirm the render stays smooth — no flicker, no garble. `.repeat(2);
    let n = 0;
    const id = setInterval(() => {
      n += 3;
      setMessages(m => {
        const copy = m.slice();
        copy[copy.length - 1] = { role: 'assistant', text: full.slice(0, n) };
        return copy;
      });
      if (n >= full.length) clearInterval(id);
    }, 16);
  };

  return (
    <box style={{ width, height, flexDirection: 'row' }}>
      {/* Main column: scrollable messages + framed input */}
      <box style={{ flexGrow: 1, flexDirection: 'column' }}>
        <scrollbox style={{ flexGrow: 1 }} focused stickyScroll stickyStart="bottom">
          {messages.map((msg, i) => <MessageRow key={i} msg={msg} />)}
        </scrollbox>
        <box style={{ border: true, borderColor: A, height: 3, paddingLeft: 1, paddingRight: 1 }}>
          <input
            value={input}
            onInput={setInput}
            onSubmit={submit}
            focused
            placeholder="ask Axion something…  (Enter to send · Esc to quit)"
          />
        </box>
      </box>

      <Sidebar
        model={model}
        modeIcon={MODE_ICONS[mode] || '·'}
        modeLabel={mode === 'auto' ? 'bypass' : mode}
        modeColor={MODE_COLORS[mode] || 'cyan'}
        ctxUsed={16300}
        ctxWindow={200000}
        mcpTools={42}
        todos={[
          { id: 1, text: 'render under OpenTUI', done: true },
          { id: 2, text: 'wire the agent + real state', done: false },
          { id: 3, text: 'port RichText / ToolBlock', done: false },
        ]}
        clock={clock}
      />
    </box>
  );
}
