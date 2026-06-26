import React, { useState, useEffect, useRef, useCallback } from 'react';

const MODELS_LIST = [
  'veil', 'lumen', 'claude', 'claude-opus', 'claude-haiku',
  'gpt', 'gpt-mini', 'gemini', 'gemini-2.5-pro',
  'groq', 'mistral', 'ollama', 'openrouter',
];

const OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct',
  'deepseek/deepseek-r1',
  'deepseek/deepseek-chat-v3-0324',
  'google/gemini-2.0-flash-exp:free',
  'google/gemini-2.5-pro-preview',
  'anthropic/claude-3-5-sonnet',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'mistralai/mixtral-8x7b-instruct',
  'qwen/qwen-2.5-72b-instruct',
];

// ── RichText renderer ─────────────────────────────────────────────────────────

function RichText({ text }) {
  if (!text) return null;
  const segments = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++; }
      segments.push(<pre key={segments.length}><code>{codeLines.join('\n')}</code></pre>);
      i++; continue;
    }
    const hMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (hMatch) {
      const Tag = `h${hMatch[1].length}`;
      segments.push(<Tag key={segments.length}>{hMatch[2]}</Tag>);
      i++; continue;
    }
    segments.push(<div key={segments.length}>{renderInline(line) || ' '}</div>);
    i++;
  }
  return <div className="rich-text">{segments}</div>;
}

function renderInline(text) {
  const parts = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const s = m[0];
    if (s.startsWith('`'))        parts.push(<code key={m.index}>{s.slice(1, -1)}</code>);
    else if (s.startsWith('**')) parts.push(<strong key={m.index}>{s.slice(2, -2)}</strong>);
    else                          parts.push(<em key={m.index}>{s.slice(1, -1)}</em>);
    last = m.index + s.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// ── Diff view ─────────────────────────────────────────────────────────────────

function DiffView({ diff }) {
  if (!diff) return null;
  return (
    <div style={{ fontFamily: 'monospace', fontSize: 11, margin: '4px 0' }}>
      {diff.map((line, i) => {
        if (line.startsWith('+')) return <div key={i} className="diff-add">{line}</div>;
        if (line.startsWith('-')) return <div key={i} className="diff-rem">{line}</div>;
        return <div key={i} style={{ color: '#555' }}>{line}</div>;
      })}
    </div>
  );
}

// ── Tool block ────────────────────────────────────────────────────────────────

function ToolBlock({ name, input, output, success, pending, diff }) {
  const [open, setOpen] = useState(false);
  const isThinking = name && name.includes('sequentialthinking');

  if (isThinking) {
    const num = input?.thoughtNumber || '?', total = input?.totalThoughts || '?';
    const thought = input?.thought || '';
    const badge = input?.isRevision ? ` · revising #${input.revisesThought}` : input?.branchId ? ` · branch ${input.branchId}` : '';
    return (
      <div className="tool-block thinking-block">
        <div className="tool-header" style={{ color: 'var(--warm2)' }}>
          <span style={{ marginRight: 6 }}>{pending ? '◌' : '💭'}</span>
          <span className="tool-name" style={{ color: 'var(--warm2)' }}>Thought {num}/{total}{badge}</span>
          {thought && <span style={{ color: '#555', fontSize: 10, marginLeft: 'auto' }} onClick={() => setOpen(v => !v)}>{open ? '▲' : '▼'}</span>}
        </div>
        {thought && (
          <div className="tool-output" style={{
            color: '#888', fontStyle: 'italic',
            display: open ? undefined : '-webkit-box',
            WebkitLineClamp: open ? undefined : 2,
            WebkitBoxOrient: open ? undefined : 'vertical',
            overflow: open ? undefined : 'hidden',
          }}>{thought}</div>
        )}
      </div>
    );
  }

  const statusClass = pending ? 'spin' : success ? 'ok' : 'err';
  const statusIcon  = pending ? '…' : success ? '✔' : '✖';
  const headerClass = `tool-header ${pending ? 'pending' : success ? 'success' : output ? 'failure' : ''}`;
  const inputSummary = input ? Object.values(input).map(v => String(v).slice(0, 80)).join('  ') : '';

  return (
    <div className="tool-block">
      <div className={headerClass} onClick={() => output && setOpen(v => !v)}>
        <span className="tool-name">{name}</span>
        <span className="tool-input">{inputSummary}</span>
        <span className={`tool-status ${statusClass}`}>{statusIcon}</span>
        {output && <span style={{ color: '#555', fontSize: 10 }}>{open ? '▲' : '▼'}</span>}
      </div>
      {open && output && (
        <div className="tool-output">{diff ? <DiffView diff={diff} /> : output}</div>
      )}
    </div>
  );
}

// ── Message row ───────────────────────────────────────────────────────────────

function MessageRow({ msg }) {
  switch (msg.type) {
    case 'user':
      return (
        <div className="msg msg-user">
          <div className="bubble bubble-user">{msg.content}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="msg msg-assistant">
          <div className="bubble bubble-ai">
            {msg.streaming
              ? <><span>{msg.content}</span><span className="streaming-cursor" /></>
              : <RichText text={msg.content} />}
          </div>
        </div>
      );
    case 'thinking': {
      const tc = msg.content || '';
      const tSize = tc.length > 500 ? `${(tc.length/1000).toFixed(1)}k` : `${tc.length} ch`;
      const tPreview = tc.split('\n').map(l => l.trim()).find(l => l.length > 0) || '';
      return (
        <div className="msg msg-thinking-block">
          <div className="thinking-header">
            <span>◈</span><strong>thinking</strong>
            <span className="thinking-size">· {tSize}</span>
          </div>
          {tPreview && <div className="thinking-preview">{tPreview.length > 120 ? tPreview.slice(0,120)+'…' : tPreview}</div>}
          {tc.length > 0 && (
            <details style={{ marginLeft: 14 }}>
              <summary style={{ color: '#555', fontSize: 11, cursor: 'pointer', userSelect: 'none' }}>expand</summary>
              <div style={{ marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--warm2)', lineHeight: 1.6 }}>
                <RichText text={tc} />
              </div>
            </details>
          )}
        </div>
      );
    }
    case 'plan':
      return <div className="msg msg-plan"><div className="msg-label plan-label">◈ Plan</div><RichText text={msg.content} /></div>;
    case 'btw':
      return <div className="msg msg-btw"><div className="msg-label btw-label">btw</div><RichText text={msg.content} /></div>;
    case 'adviser':
      return <div className="msg msg-adviser"><div className="msg-label adviser-label">◈ Adviser{msg.label ? ` (${msg.label})` : ''}</div><RichText text={msg.content} /></div>;
    case 'sub-agent':
      return <div className="msg msg-sub-agent"><div className="msg-label sub-label">⟳ {msg.label || 'agent'}</div><RichText text={msg.content} /></div>;
    case 'agent-msg':
      return <div className="msg msg-agent-msg">📨 <strong>{msg.from}</strong> → <strong>{msg.to}</strong>: "{msg.content}"</div>;
    case 'img':
      return (
        <div className="msg msg-img">
          <div className="msg-label" style={{ color: 'var(--warm1)', marginBottom: 4 }}>◈ image · {msg.model}</div>
          <img src={`data:image/png;base64,${msg.b64}`} alt={msg.revisedPrompt || msg.prompt}
            style={{ maxWidth: '100%', maxHeight: 400, borderRadius: 8, border: '1px solid var(--border)', display: 'block' }} />
          {msg.revisedPrompt && msg.revisedPrompt !== msg.prompt && (
            <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 4 }}>Revised: {msg.revisedPrompt}</div>
          )}
        </div>
      );
    case 'tool':
      return <div className="msg"><ToolBlock {...msg} /></div>;
    case 'error':
      return <div className="msg msg-error">✖ {msg.content}</div>;
    case 'info':
      return <div className="msg msg-info">{msg.content}</div>;
    default:
      return null;
  }
}

// ── Spinner ───────────────────────────────────────────────────────────────────

const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧'];
function Spinner() {
  const [f, setF] = useState(0);
  useEffect(() => { const id = setInterval(() => setF(x => (x+1)%FRAMES.length), 100); return () => clearInterval(id); }, []);
  return <span style={{ display: 'inline-block', width: '1ch' }}>{FRAMES[f]}</span>;
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({ open, chats, activeTab, sessionTab, onTabChange, onNewChat, onResume, onRefresh, onToggle, onDeleteChat, onRenameChat, onSettings, consoleActive }) {
  const [renaming, setRenaming]       = useState(null); // { name, value }
  const [contextMenu, setContextMenu] = useState(null); // { x, y, name }

  function fmtDate(iso) {
    if (!iso) return 'Saved';
    const d = new Date(iso), now = new Date();
    const diff = Math.floor((now - d) / 86400000);
    if (diff === 0 && now.getDate() === d.getDate()) return 'Today';
    if (diff <= 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // Only show chats that match the active tab
  const tabChats = chats.filter(c => (c.tab || 'code') === activeTab);

  const grouped = {};
  for (const c of tabChats) {
    const g = fmtDate(c.savedAt);
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(c);
  }

  function commitRename(c) {
    if (renaming && renaming.value.trim() && renaming.value.trim() !== c.name) {
      onRenameChat(c.name, renaming.value.trim());
    }
    setRenaming(null);
  }

  // Dismiss context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener('click', dismiss);
    window.addEventListener('contextmenu', dismiss);
    return () => { window.removeEventListener('click', dismiss); window.removeEventListener('contextmenu', dismiss); };
  }, [contextMenu]);

  return (
    <div id="sidebar" className={open ? '' : 'collapsed'}>
      <div className="sidebar-header">
        <span className="sidebar-brand">◈ Axion</span>
        <button className="sidebar-icon-btn" onClick={onToggle} title="Collapse">←</button>
      </div>

      <button className="new-chat-btn" onClick={onNewChat}>
        <span className="new-chat-plus">+</span> New chat
      </button>

      <nav className="sidebar-nav">
        <button
          className={`sidebar-nav-item ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => !sessionTab && onTabChange('chat')}
          disabled={!!sessionTab && activeTab !== 'chat'}
          title={sessionTab && activeTab !== 'chat' ? 'Start a new chat to switch tabs' : 'Chat mode'}
        >
          <span className="nav-icon">💬</span> Chat
        </button>
        <button
          className={`sidebar-nav-item ${activeTab === 'code' ? 'active' : ''}`}
          onClick={() => !sessionTab && onTabChange('code')}
          disabled={!!sessionTab && activeTab !== 'code'}
          title={sessionTab && activeTab !== 'code' ? 'Start a new chat to switch tabs' : 'Code mode'}
        >
          <span className="nav-icon">⌨</span> Code
        </button>
        <button
          className={`sidebar-nav-item ${consoleActive ? 'active' : ''}`}
          onClick={() => onTabChange('console')}
          title="Open a system terminal (powershell)"
        >
          <span className="nav-icon">⎔</span> Console
        </button>
      </nav>

      <div className="sidebar-divider" />

      <div className="sidebar-chats">
        {tabChats.length === 0 ? (
          <div className="sidebar-empty">
            No {activeTab} chats yet<br />
            <span>Chats auto-save after first message</span>
          </div>
        ) : (
          Object.entries(grouped).map(([grp, items]) => (
            <div key={grp} className="sidebar-group">
              <div className="sidebar-group-title">{grp}</div>
              {items.map(c => (
                <div key={c.name} className="sidebar-chat-item-wrap">
                  {renaming?.name === c.name ? (
                    <input
                      className="chat-rename-input"
                      value={renaming.value}
                      onChange={e => setRenaming(r => ({ ...r, value: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename(c);
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={() => commitRename(c)}
                      autoFocus
                    />
                  ) : (
                    <button
                      className="sidebar-chat-item"
                      onClick={() => onResume(c.name)}
                      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, name: c.name }); }}
                      title={`${c.name}\nRight-click for options`}
                    >
                      <span className="chat-item-name">{c.name}</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className="chat-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          <button className="ctx-item" onClick={() => { onResume(contextMenu.name); setContextMenu(null); }}>
            ▶ Resume
          </button>
          <button className="ctx-item" onClick={() => { setRenaming({ name: contextMenu.name, value: contextMenu.name }); setContextMenu(null); }}>
            ✏ Rename
          </button>
          <div className="ctx-divider" />
          <button className="ctx-item ctx-item-danger" onClick={() => { onDeleteChat(contextMenu.name); setContextMenu(null); }}>
            🗑 Delete
          </button>
        </div>
      )}

      <div className="sidebar-footer">
        <button className="sidebar-refresh-btn" onClick={onRefresh}>↻ Refresh</button>
        <button className="sidebar-settings-btn" onClick={onSettings} title="Settings">⚙ Settings</button>
      </div>
    </div>
  );
}

// ── Welcome card ──────────────────────────────────────────────────────────────

function WelcomeCard({ tab, onFill }) {
  const chatActions = [
    { label: 'Write',   icon: '✏', s: 'Help me write ' },
    { label: 'Explain', icon: '◎', s: 'Explain: ' },
    { label: 'Plan',    icon: '◈', s: 'Help me plan ' },
    { label: 'Analyze', icon: '◉', s: 'Analyze: ' },
  ];
  const codeActions = [
    { label: 'Read file',  icon: '📄', s: 'Read the file ' },
    { label: 'Write code', icon: '⌨', s: 'Write a ' },
    { label: 'Run tests',  icon: '✓', s: 'Run the tests and fix any failures' },
    { label: 'Debug',      icon: '⚡', s: 'Debug this:\n\n' },
  ];
  const actions = tab === 'code' ? codeActions : chatActions;

  return (
    <div className="welcome-center">
      <div className="welcome-icon">◈</div>
      <div className="welcome-title">
        {tab === 'code' ? 'Code with Axion' : 'How can I help you today?'}
      </div>
      <div className="welcome-chips">
        {actions.map(a => (
          <button key={a.label} className="welcome-chip" onClick={() => onFill(a.s)}>
            <span className="chip-icon">{a.icon}</span> {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Settings panel ────────────────────────────────────────────────────────────

function SettingsPanel({ status, onClose, onSend }) {
  const tokens = status?.tokens || { total: 0, input: 0, output: 0 };
  const model  = status?.model || '—';
  const mode   = status?.mode  || 'ask';
  const extThinking = status?.extThinking || false;

  function fmtNum(n) {
    if (!n) return '0';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n/1000).toFixed(1)}k`;
    return `${(n/1_000_000).toFixed(2)}M`;
  }

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <span className="settings-title">⚙ Settings</span>
        <button className="settings-close-btn" onClick={onClose}>✕</button>
      </div>

      <div className="settings-body">

        <div className="settings-section">
          <div className="settings-section-title">Model</div>
          <select
            className="settings-select"
            value={model}
            onChange={e => onSend(`/model ${e.target.value}`)}
          >
            <optgroup label="Built-in aliases">
              {MODELS_LIST.map(m => <option key={m} value={m}>{m}</option>)}
            </optgroup>
            <optgroup label="OpenRouter models">
              {OPENROUTER_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
            </optgroup>
          </select>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Mode</div>
          <div className="settings-mode-row">
            {['ask','plan','auto'].map(m => (
              <button
                key={m}
                className={`settings-mode-btn ${mode === m ? 'active' : ''}`}
                onClick={() => onSend(`/mode ${m}`)}
              >
                {m === 'auto' ? 'bypass' : m}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Extended Thinking</div>
          <div className="settings-row">
            <span className="settings-label">Status</span>
            <div className="settings-row-right">
              <button
                className={`settings-toggle ${extThinking ? 'on' : ''}`}
                onClick={() => onSend(extThinking ? '/thinking off' : '/thinking on')}
              >
                {extThinking ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Token Usage (session)</div>
          <div className="settings-tokens">
            <div className="settings-token-row">
              <span>Input</span><span className="settings-token-val">{fmtNum(tokens.input)}</span>
            </div>
            <div className="settings-token-row">
              <span>Output</span><span className="settings-token-val">{fmtNum(tokens.output)}</span>
            </div>
            <div className="settings-token-row settings-token-total">
              <span>Total</span><span className="settings-token-val">{fmtNum(tokens.total)}</span>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Quick Actions</div>
          <div className="settings-quick-actions">
            <button className="settings-action-btn" onClick={() => onSend('/compact')}>⟳ Compact history</button>
            <button className="settings-action-btn" onClick={() => onSend('/clear')}>✕ Clear session</button>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">About</div>
          <div className="settings-about">
            <div>API keys stored in <code>~/.axion/.env</code></div>
            <div>Chats saved to <code>~/.axion/chats/</code></div>
            <div style={{ marginTop: 8, color: 'var(--muted)' }}>
              Use <code>/help</code> in chat for all commands
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

// ── Console Terminal Panel ─────────────────────────────────────────────────────

function ConsolePanel({ wsRef }) {
  const termRef = useRef(null);
  const termInitRef = useRef(false);

  useEffect(() => {
    if (termInitRef.current) return;
    termInitRef.current = true;

    const term = new window.Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 14,
      fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace',
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        selectionBackground: '#585b70',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
    });

    const el = termRef.current;
    if (!el) return;
    term.open(el);

    // Connect terminal I/O via WebSocket
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'terminal_start' }));
    }

    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'terminal_input', data }));
      }
    });

    const handler = (evt) => {
      const d = JSON.parse(evt.data);
      if (d.type === 'terminal_output') term.write(d.data);
      if (d.type === 'terminal_end') term.write('\r\n\x1b[31m[process exited]\x1b[0m\r\n');
    };
    ws?.addEventListener('message', handler);

    return () => {
      ws?.removeEventListener('message', handler);
      term.dispose();
      termInitRef.current = false;
    };
  }, [wsRef]);

  return <div ref={termRef} style={{ height: '100%', width: '100%' }} />;
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [messages, setMessages]           = useState([]);
  const [streamContent, setStreamContent] = useState(null);
  const [thinking, setThinking]           = useState(false);
  const [thinkingWord, setThinkingWord]   = useState('');
  const [inputMode, setInputMode]         = useState('chat');
  const [confirmInfo, setConfirmInfo]     = useState(null);
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const [status, setStatus]               = useState(null);
  const [inputValue, setInputValue]       = useState('');
  const [connected, setConnected]         = useState(false);
  const [chats, setChats]                 = useState([]);
  const [sidebarOpen, setSidebarOpen]     = useState(true);
  const [activeTab, setActiveTab]         = useState('code');
  const [sessionTab, setSessionTab]       = useState(null); // null = new chat (tab unlocked)
  const [queuedCount, setQueuedCount]     = useState(0);
  const [showSettings, setShowSettings]   = useState(false);
  const [chatName, setChatName]           = useState('');
  const [theme, setTheme]                 = useState(() => {
    try { return localStorage.getItem('axion-theme') || 'light'; } catch { return 'light'; }
  });

  const wsRef          = useRef(null);
  const streamBufRef   = useRef('');
  const messagesEndRef = useRef(null);
  const inputRef       = useRef(null);
  const fileInputRef   = useRef(null);
  const [attachedFiles, setAttachedFiles] = useState([]); // [{name, path}]

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  const pushMsg = useCallback((msg) => {
    setMessages(prev => [...prev, { ...msg, _key: Math.random() }]);
  }, []);

  const updateLastTool = useCallback((name, update) => {
    setMessages(prev => {
      const idx = [...prev].reverse().findIndex(m => m.type === 'tool' && m.name === name && m.pending);
      if (idx === -1) return prev;
      const ri = prev.length - 1 - idx;
      const next = [...prev];
      next[ri] = { ...next[ri], ...update };
      return next;
    });
  }, []);

  // ── WebSocket ─────────────────────────────────────────────────────────────

  const sendWs = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(data));
  }, []);

  const sendCmd = useCallback((cmd) => {
    sendWs({ type: 'submit', content: cmd });
  }, [sendWs]);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws    = new WebSocket(`${proto}://${location.host}`);
    wsRef.current = ws;

    ws.onopen  = () => { setConnected(true); ws.send(JSON.stringify({ type: 'hello', clientType: 'web' })); };
    ws.onclose = () => setConnected(false);

    ws.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      switch (data.type) {

        case 'welcome':
          setConnected(true);
          setStatus({ model: data.model, mode: data.mode, tokens: { total: 0, input: 0, output: 0 } });
          if (data.chats) setChats(data.chats);
          if (data.history?.length) setMessages(data.history.map(m => ({ ...m, _key: Math.random() })));
          if (data.sessionTab) { setSessionTab(data.sessionTab); setActiveTab(data.sessionTab); }
          if (data.chatName) setChatName(data.chatName);
          break;

        case 'chat_name':
          setChatName(data.name || '');
          break;

        case 'chats_list':
          setChats(data.chats || []);
          break;

        case 'queue_update':
          setQueuedCount(data.count || 0);
          break;

        case 'message':
          pushMsg(data.msg);
          break;

        case 'tool_call':
          pushMsg({ type: 'tool', id: data.id, name: data.name, input: data.input, output: null, success: null, pending: true });
          break;

        case 'tool_result':
          updateLastTool(data.name, { output: data.output, success: data.success, pending: false, diff: data.diff || null });
          break;

        case 'stream_chunk':
          streamBufRef.current += data.content;
          setStreamContent(streamBufRef.current);
          break;

        case 'stream_end': {
          const raw = streamBufRef.current;
          streamBufRef.current = '';
          setStreamContent(null);
          const thinkRe = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
          const thoughts = [];
          let m;
          while ((m = thinkRe.exec(raw)) !== null) { if (m[1].trim()) thoughts.push(m[1].trim()); }
          const content = thoughts.length ? raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim() : raw;
          for (const t of thoughts) pushMsg({ type: 'thinking', content: t });
          if (content.trim()) pushMsg({ type: 'assistant', content });
          break;
        }

        case 'thinking_start':
          setThinking(true); setThinkingWord(data.word || '');
          break;

        case 'thinking_end':
          setThinking(false); setThinkingWord('');
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'list_chats' }));
          }
          break;

        case 'question':
          setPendingQuestion(data.prompt);
          setInputMode('question');
          break;

        case 'confirm_request':
          setInputMode(data.kind === 'tool' ? 'confirm-tool' : 'confirm-plan');
          setConfirmInfo(data.kind === 'tool' ? data.tool : null);
          break;

        case 'tokens':
          setStatus(s => s ? { ...s, tokens: { total: data.total, input: data.input, output: data.output } } : s);
          break;

        case 'status':
          setStatus(s => ({ ...s, model: data.model, mode: data.mode, tokens: data.tokens || s?.tokens || { total: 0, input: 0, output: 0 }, goal: data.goal, extThinking: data.extThinking }));
          break;

        case 'session_tab':
          setSessionTab(data.tab);
          setActiveTab(data.tab);
          break;

        case 'clear':
          setMessages([]); setStreamContent(null); streamBufRef.current = ''; setQueuedCount(0);
          setSessionTab(null); setChatName('');
          break;

        case 'resume':
          setMessages((data.messages || []).map(m => ({ ...m, _key: Math.random() })));
          setStatus(s => ({ ...s, model: data.model, mode: data.mode }));
          if (data.tab) { setSessionTab(data.tab); setActiveTab(data.tab); }
          break;

        default: break;
      }
    };

    return () => ws.close();
  }, [pushMsg, updateLastTool]);

  useEffect(() => { scrollToBottom(); }, [messages, streamContent, thinking]);

  // ── Theme (light / dark) ────────────────────────────────────────────────────

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('axion-theme', theme); } catch {}
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  // ── ESC to cancel ─────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && thinking) { e.preventDefault(); sendWs({ type: 'cancel' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [thinking, sendWs]);

  // ── Send ──────────────────────────────────────────────────────────────────

  const sendConfirm = useCallback((answer) => {
    sendWs({ type: 'confirm', answer });
    setInputMode('chat');
    setConfirmInfo(null);
    inputRef.current?.focus();
  }, [sendWs]);

  const sendQuestionAnswer = useCallback((answer) => {
    sendWs({ type: 'question_answer', answer });
    setInputMode('chat');
    setPendingQuestion(null);
    setInputValue('');
    inputRef.current?.focus();
  }, [sendWs]);

  const handleSubmit = useCallback(() => {
    const val = inputValue.trim();
    if (!val && !attachedFiles.length) return;
    if (inputMode === 'confirm-tool' || inputMode === 'confirm-plan') {
      const lower = val.toLowerCase();
      if (lower === 'y' || lower === 'yes') sendConfirm(true);
      if (lower === 'n' || lower === 'no')  sendConfirm(false);
      setInputValue('');
      return;
    }
    if (inputMode === 'question') {
      sendQuestionAnswer(val);
      return;
    }
    const uploadPaths = attachedFiles.map((f) => f.path);
    sendWs({ type: 'submit', content: val, tab: activeTab, uploadPaths });
    setInputValue('');
    setAttachedFiles([]);
    if (inputRef.current) inputRef.current.style.height = 'auto';
  }, [inputValue, inputMode, sendWs, sendConfirm, sendQuestionAnswer, activeTab, attachedFiles]);

  const handleFileSelect = useCallback((e) => {
    const files = e.target.files;
    if (!files?.length) return;
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        sendWs({ type: 'file_upload', name: file.name, data: base64 });
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  }, [sendWs]);

  useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === 'file_uploaded') {
        setAttachedFiles((prev) => [...prev, { name: e.data.name, path: e.data.path }]);
      }
    };
    const ws = wsRef.current;
    if (!ws) return;
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        sendWs({ type: 'file_upload', name: file.name, data: base64 });
      };
      reader.readAsDataURL(file);
    }
  }, [sendWs]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
  }, []);

  const removeAttachedFile = useCallback((idx) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  }, [handleSubmit]);

  const autoResize = useCallback((el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, []);

  const handleDeleteChat = useCallback((name) => {
    sendCmd(`/remove-chat ${name}`);
  }, [sendCmd]);

  const handleRenameChat = useCallback((oldName, newName) => {
    sendCmd(`/rename-chat ${oldName} ${newName}`);
  }, [sendCmd]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const tokStr = status?.tokens?.total
    ? status.tokens.total < 1000 ? `${status.tokens.total}`
      : status.tokens.total < 1_000_000 ? `${(status.tokens.total/1000).toFixed(1)}k`
      : `${(status.tokens.total/1_000_000).toFixed(2)}M`
    : null;

  const currentMode = status?.mode || 'ask';
  const displayMode = currentMode === 'auto' ? 'bypass' : currentMode;

  const cycleMode = useCallback(() => {
    const modes = ['ask','plan','auto'];
    const next  = modes[(modes.indexOf(currentMode) + 1) % modes.length];
    sendWs({ type: 'submit', content: `/mode ${next}` });
  }, [currentMode, sendWs]);

  const inputDisabled = !connected || (inputMode !== 'chat' && inputMode !== 'confirm-tool' && inputMode !== 'confirm-plan' && inputMode !== 'question');

  const placeholder = !connected ? 'Connecting…'
    : inputMode === 'question' ? (pendingQuestion?.type === 'multiple_choice' ? 'Type a number…' : 'Type your answer…')
    : inputMode === 'confirm-tool' || inputMode === 'confirm-plan' ? 'y / n'
    : thinking ? `${thinkingWord}… — ESC to stop, /btw for side question`
    : activeTab === 'code' ? 'Ask Axion to read, write, or run code…'
    : 'Ask Axion anything…';

  const visibleMessages = activeTab === 'chat'
    ? messages.filter(m => m.type !== 'tool')
    : messages;

  const hasMessages = visibleMessages.length > 0 || streamContent !== null;

  return (
    <div id="layout">
      <Sidebar
        open={sidebarOpen}
        chats={chats}
        activeTab={activeTab}
        sessionTab={sessionTab}
        consoleActive={activeTab === 'console'}
        onTabChange={tab => { setActiveTab(tab); setShowSettings(false); }}
        onNewChat={() => { sendWs({ type: 'submit', content: '/clear' }); setShowSettings(false); }}
        onRefresh={() => sendWs({ type: 'list_chats' })}
        onToggle={() => setSidebarOpen(v => !v)}
        onDeleteChat={handleDeleteChat}
        onRenameChat={handleRenameChat}
        onSettings={() => setShowSettings(v => !v)}
      />

      <div id="main">
        {/* Top bar */}
        <div id="topbar">
          {!sidebarOpen && (
            <button className="sidebar-open-btn" onClick={() => setSidebarOpen(true)}>≡</button>
          )}
          <div className="topbar-title">
            {showSettings
              ? '⚙ Settings'
              : chatName
                ? `Axion | ${chatName}`
                : activeTab === 'code'
                  ? '⌨ Code'
                  : '💬 Chat'}
          </div>
          <div style={{ flex: 1 }} />
          <div className="topbar-badges">
            {thinking && queuedCount > 0 && (
              <span className="topbar-badge badge-orange">⏱ {queuedCount} queued</span>
            )}
            {status?.extThinking && <span className="topbar-badge badge-warm">◎ thinking</span>}
            {status?.goal        && <span className="topbar-badge badge-warm">⟳ goal</span>}
            {!connected          && <span className="topbar-badge badge-red">● offline</span>}
          </div>
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >{theme === 'dark' ? '☀' : '☾'}</button>
          {thinking && (
            <button
              className="stop-btn"
              onClick={() => sendWs({ type: 'cancel' })}
              title="Stop generation (Esc)"
            >⊘ Stop</button>
          )}
        </div>

        {showSettings ? (
          <SettingsPanel
            status={status}
            onClose={() => setShowSettings(false)}
            onSend={cmd => { sendCmd(cmd); }}
          />
        ) : activeTab === 'console' ? (

          /* ── Console / terminal ──────────────────────────────────────────── */
          <div id="terminal-wrap" className="active" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div className="console-toolbar">
              <span>⎔ Terminal</span>
              <span className="console-status connected">● connected</span>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ConsolePanel wsRef={wsRef} />
            </div>
          </div>

        ) : (
          <>
            {/* Messages */}
            <div id="messages" className={hasMessages ? '' : 'empty'}>
              {!hasMessages && (
                <WelcomeCard
                  tab={activeTab}
                  onFill={s => { setInputValue(s); setTimeout(() => inputRef.current?.focus(), 0); }}
                />
              )}
              {visibleMessages.map((msg, i) => <MessageRow key={msg._key ?? i} msg={msg} />)}
              {streamContent !== null && (
                <MessageRow msg={{ type: 'assistant', content: streamContent, streaming: true }} />
              )}
              <div ref={messagesEndRef} style={{ height: 8 }} />
            </div>

            {/* Thinking bar */}
            {thinking && (
              <div id="thinking-bar">
                <Spinner /> <span>{thinkingWord || 'thinking'}…</span>
                <span className="thinking-esc">ESC to stop</span>
              </div>
            )}

            {/* Confirm bar */}
            {(inputMode === 'confirm-tool' || inputMode === 'confirm-plan') && (
              <div id="confirm-bar">
                <span className="confirm-label">
                  {inputMode === 'confirm-tool'
                    ? <>run <strong style={{ color: 'var(--warm1)' }}>{confirmInfo?.name}</strong>{confirmInfo?.label ? <> · <span style={{ color: '#888' }}>{confirmInfo.label}</span></> : null}?</>
                    : 'execute this plan?'}
                </span>
                <button className="confirm-btn confirm-yes" onClick={() => sendConfirm(true)}>Yes (y)</button>
                <button className="confirm-btn confirm-no"  onClick={() => sendConfirm(false)}>No (n)</button>
              </div>
            )}

            {/* Question prompt */}
            {inputMode === 'question' && pendingQuestion && (
              <div id="question-bar">
                <div className="question-type">{pendingQuestion.type === 'multiple_choice' ? '☰ Pick one' : pendingQuestion.type === 'confirm' ? '✓ Confirm' : '✎ Question'}</div>
                <div className="question-text">{pendingQuestion.question}</div>
                {pendingQuestion.type === 'multiple_choice' && pendingQuestion.options && (
                  <div className="question-options">
                    {pendingQuestion.options.map((opt, i) => (
                      <button key={i} className="question-option" onClick={() => sendQuestionAnswer(opt)}>
                        {i + 1}. {opt}
                      </button>
                    ))}
                  </div>
                )}
                {pendingQuestion.type === 'confirm' && (
                  <div className="question-confirm-btns">
                    <button className="confirm-btn confirm-yes" onClick={() => sendQuestionAnswer('yes')}>Yes</button>
                    <button className="confirm-btn confirm-no"  onClick={() => sendQuestionAnswer('no')}>No</button>
                  </div>
                )}
              </div>
            )}

            {/* Input area */}
            <div id="input-wrap" onDrop={handleDrop} onDragOver={handleDragOver}>
              <div className="input-card">
                <textarea
                  id="chat-input"
                  ref={inputRef}
                  value={inputValue}
                  onChange={e => { setInputValue(e.target.value); autoResize(e.target); }}
                  onKeyDown={handleKeyDown}
                  placeholder={placeholder}
                  disabled={inputDisabled}
                  rows={1}
                  autoFocus
                />
                {attachedFiles.length > 0 && (
                  <div className="attach-pills">
                    {attachedFiles.map((f, i) => (
                      <span key={i} className="attach-pill">
                        {f.name}
                        <button className="attach-remove" onClick={() => removeAttachedFile(i)}>×</button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="input-footer">
                  <div className="input-footer-left">
                    <button className={`mode-badge mode-badge-${currentMode}`} onClick={cycleMode} title="Click to cycle: ask → plan → bypass">
                      {displayMode}
                    </button>
                    {tokStr && <span className="tok-count">{tokStr} tok</span>}
                  </div>
                  <div className="input-footer-right">
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileSelect}
                      style={{ display: 'none' }}
                      multiple
                    />
                    <button
                      className="attach-btn"
                      onClick={() => fileInputRef.current?.click()}
                      title="Attach file"
                    >📎</button>
                    <select
                      className="model-select"
                      value={status?.model || ''}
                      onChange={e => sendWs({ type: 'submit', content: `/model ${e.target.value}` })}
                      title="Switch model"
                    >
                      <optgroup label="Built-in aliases">
                        {MODELS_LIST.map(m => <option key={m} value={m}>{m}</option>)}
                      </optgroup>
                      <optgroup label="OpenRouter">
                        {OPENROUTER_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                      </optgroup>
                    </select>
                    <button
                      className="send-btn"
                      onClick={handleSubmit}
                      disabled={(!inputValue.trim() && !attachedFiles.length) || inputDisabled}
                      title="Send (Enter)"
                    >↑</button>
                  </div>
                </div>
              </div>
              <div className="hint-text">
                Shift+Enter for newline · /help for commands · ESC to stop · click mode to cycle · 📎 attach files
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
